/**
 * Platform Billing — /api/platform-billing/*
 *
 * Facturation SaaS : MaTable prélève les RESTAURANTS via le compte Stripe
 * de la plateforme (distinct du Stripe par-resto qui encaisse les clients).
 *
 * Config 100% dynamique dans GlobalConfig.platformBilling (clés + price IDs).
 * Tout est inerte tant que la config est vide / désactivée.
 *
 * POST /checkout  (pro) → URL Stripe Checkout (abonnement mensuel/annuel)
 * POST /portal    (pro) → URL Stripe Customer Portal (gérer CB / résilier)
 * GET  /status    (pro) → état d'abonnement du resto
 * POST /webhook         → events Stripe → MAJ resto + SubscriptionEvent
 */
import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import { prisma } from "../db.js";
import { requirePro } from "../auth.js";
import { randomUUID } from "crypto";

const APP_BASE = "https://matable.pro";

// MRR mensuel normalisé (centimes) par plan — l'annuel garde le même MRR.
const PLAN_MRR_CENTS: Record<string, number> = { STARTER: 5900, PRO: 11900, PRO_IA: 24900 };
const KEY_TO_ENUM: Record<string, string> = { starter: "STARTER", pro: "PRO", business: "PRO_IA" };
const PLAN_APPS: Record<string, string[]> = {
  STARTER: ["reviews", "reservations", "orders"],
  PRO:     ["reviews", "reservations", "orders"],
  PRO_IA:  ["reviews", "reservations", "orders", "nova_ia", "nova_stock", "nova_contab", "nova_finance"],
};

type PlatformBilling = {
  enabled: boolean;
  stripeSecretKey: string;
  stripePublicKey: string;
  stripeWebhookSecret: string;
  currency: string;
  trialDays: number;
  prices: {
    starter:  { monthly: string; yearly: string };
    pro:      { monthly: string; yearly: string };
    business: { monthly: string; yearly: string };
  };
};

let stripeCache: { key: string; instance: Stripe } | null = null;
function getStripe(secretKey: string): Stripe {
  if (!stripeCache || stripeCache.key !== secretKey) {
    stripeCache = { key: secretKey, instance: new Stripe(secretKey) };
  }
  return stripeCache.instance;
}

async function getConfig(): Promise<PlatformBilling | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ platformBilling: any }>>(
      `SELECT "platformBilling" FROM "GlobalConfig" WHERE id = 'global' LIMIT 1`
    );
    const raw = rows[0]?.platformBilling;
    if (!raw || !raw.stripeSecretKey) return null;
    return raw as PlatformBilling;
  } catch {
    return null;
  }
}

/** Reverse map priceId → { planKey, interval } depuis la config. */
function priceToplan(cfg: PlatformBilling, priceId: string): { enumPlan: string } | null {
  for (const [key, p] of Object.entries(cfg.prices)) {
    if (p.monthly === priceId || p.yearly === priceId) {
      return { enumPlan: KEY_TO_ENUM[key] ?? "STARTER" };
    }
  }
  return null;
}

async function logSubEvent(opts: {
  restaurantId: string; restaurantName?: string | null;
  type: string; plan: string; mrrCents: number; mrrDeltaCents: number;
}) {
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "SubscriptionEvent"
        ("id","restaurantId","restaurantName","type","plan","mrrCents","mrrDeltaCents")
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      `se_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      opts.restaurantId, opts.restaurantName ?? null, opts.type, opts.plan,
      opts.mrrCents, opts.mrrDeltaCents,
    );
  } catch (e) {
    console.warn("[platformBilling] logSubEvent skipped:", (e as Error).message?.split("\n")[0]);
  }
}

/** Applique un plan à un resto (subscription + dates + enabledApps) + journalise. */
async function applyPlanToRestaurant(restaurantId: string, enumPlan: string, periodEnd: Date | null) {
  const before = await prisma.$queryRawUnsafe<Array<{ subscription: string; name: string; subscriptionStartedAt: Date | null }>>(
    `SELECT subscription::text AS subscription, name, "subscriptionStartedAt" FROM "Restaurant" WHERE id = $1`,
    restaurantId,
  );
  const prev = before[0];
  const oldMrr = prev?.subscriptionStartedAt ? (PLAN_MRR_CENTS[prev.subscription] ?? 0) : 0;
  const newMrr = PLAN_MRR_CENTS[enumPlan] ?? 0;
  const type = !prev?.subscriptionStartedAt ? "created"
    : newMrr > oldMrr ? "upgraded"
    : newMrr < oldMrr ? "downgraded"
    : "renewed";

  const expires = periodEnd ?? new Date(Date.now() + 31 * 86400_000);
  await prisma.$executeRawUnsafe(
    `UPDATE "Restaurant"
       SET subscription = $1::"SubscriptionPlan",
           "subscriptionStartedAt" = COALESCE("subscriptionStartedAt", CURRENT_TIMESTAMP),
           "subscriptionExpiresAt" = $2,
           "enabledApps" = $3::jsonb
     WHERE id = $4`,
    enumPlan, expires, JSON.stringify(PLAN_APPS[enumPlan] ?? PLAN_APPS.STARTER), restaurantId,
  );

  await logSubEvent({
    restaurantId, restaurantName: prev?.name, type, plan: enumPlan,
    mrrCents: newMrr, mrrDeltaCents: newMrr - oldMrr,
  });
}

export async function platformBillingRoutes(app: FastifyInstance) {

  // ── GET /status ────────────────────────────────────────────────────────────
  app.get("/status", async (req, reply) => {
    const me = await requirePro(req, reply);
    const cfg = await getConfig();
    const rows = await prisma.$queryRawUnsafe<Array<{
      subscription: string; subscriptionExpiresAt: Date | null; platformStripeSubscriptionId: string | null;
    }>>(
      `SELECT subscription::text AS subscription, "subscriptionExpiresAt", "platformStripeSubscriptionId"
       FROM "Restaurant" WHERE id = $1`, me.restaurantId,
    );
    const r = rows[0];
    return {
      billingEnabled: !!(cfg?.enabled),
      plan: r?.subscription ?? "STARTER",
      expiresAt: r?.subscriptionExpiresAt ?? null,
      subscribed: !!r?.platformStripeSubscriptionId,
    };
  });

  // ── POST /checkout ───────────────────────────────────────────────────────────
  app.post("/checkout", async (req, reply) => {
    const me = await requirePro(req, reply);
    const cfg = await getConfig();
    if (!cfg || !cfg.enabled) return reply.code(503).send({ error: "billing_not_configured" });

    const { plan, interval } = z.object({
      plan: z.enum(["starter", "pro", "business"]),
      interval: z.enum(["monthly", "yearly"]),
    }).parse(req.body ?? {});

    const priceId = (cfg.prices as any)[plan]?.[interval] as string | undefined;
    if (!priceId) return reply.code(400).send({ error: "price_not_configured" });

    const stripe = getStripe(cfg.stripeSecretKey);

    const rows = await prisma.$queryRawUnsafe<Array<{
      name: string; email: string | null; platformStripeCustomerId: string | null;
    }>>(
      `SELECT name, email, "platformStripeCustomerId" FROM "Restaurant" WHERE id = $1`, me.restaurantId,
    );
    const r = rows[0];
    if (!r) return reply.code(404).send({ error: "restaurant_not_found" });

    // Customer Stripe (réutilise ou crée)
    let customerId = r.platformStripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: r.name,
        email: r.email ?? undefined,
        metadata: { restaurantId: me.restaurantId },
      });
      customerId = customer.id;
      await prisma.$executeRawUnsafe(
        `UPDATE "Restaurant" SET "platformStripeCustomerId" = $1 WHERE id = $2`,
        customerId, me.restaurantId,
      );
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: cfg.trialDays > 0 ? { trial_period_days: cfg.trialDays } : undefined,
      metadata: { restaurantId: me.restaurantId, plan },
      success_url: `${APP_BASE}/dashboard/settings?billing=success`,
      cancel_url: `${APP_BASE}/dashboard/settings?billing=cancel`,
    });

    return { url: session.url };
  });

  // ── POST /portal ─────────────────────────────────────────────────────────────
  app.post("/portal", async (req, reply) => {
    const me = await requirePro(req, reply);
    const cfg = await getConfig();
    if (!cfg || !cfg.enabled) return reply.code(503).send({ error: "billing_not_configured" });

    const rows = await prisma.$queryRawUnsafe<Array<{ platformStripeCustomerId: string | null }>>(
      `SELECT "platformStripeCustomerId" FROM "Restaurant" WHERE id = $1`, me.restaurantId,
    );
    const customerId = rows[0]?.platformStripeCustomerId;
    if (!customerId) return reply.code(400).send({ error: "no_customer" });

    const stripe = getStripe(cfg.stripeSecretKey);
    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_BASE}/dashboard/settings`,
    });
    return { url: portal.url };
  });

  // ── POST /webhook ─────────────────────────────────────────────────────────────
  app.post("/webhook", { config: { rawBody: true } }, async (req, reply) => {
    const cfg = await getConfig();
    if (!cfg || !cfg.stripeWebhookSecret) return reply.code(503).send({ error: "billing_not_configured" });

    const sig = req.headers["stripe-signature"] as string;
    if (!sig) return reply.code(400).send({ error: "missing_signature" });

    const stripe = getStripe(cfg.stripeSecretKey);
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent((req as any).rawBody, sig, cfg.stripeWebhookSecret);
    } catch {
      return reply.code(400).send({ error: "bad_signature" });
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const s = event.data.object as Stripe.Checkout.Session;
          if (s.mode !== "subscription") break;
          const restaurantId = s.metadata?.restaurantId;
          const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
          if (!restaurantId || !subId) break;
          const sub = await stripe.subscriptions.retrieve(subId);
          const priceId = sub.items.data[0]?.price?.id ?? "";
          const enumPlan = priceToplan(cfg, priceId)?.enumPlan ?? KEY_TO_ENUM[s.metadata?.plan ?? "starter"];
          const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
          await prisma.$executeRawUnsafe(
            `UPDATE "Restaurant" SET "platformStripeSubscriptionId" = $1, "platformStripeCustomerId" = COALESCE("platformStripeCustomerId", $2) WHERE id = $3`,
            subId, typeof s.customer === "string" ? s.customer : s.customer?.id ?? null, restaurantId,
          );
          await applyPlanToRestaurant(restaurantId, enumPlan, periodEnd);
          break;
        }

        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          const restaurantId = (sub.metadata?.restaurantId) || await restaurantIdFromCustomer(sub.customer);
          if (!restaurantId) break;
          const priceId = sub.items.data[0]?.price?.id ?? "";
          const enumPlan = priceToplan(cfg, priceId)?.enumPlan;
          const periodEnd = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
          if (enumPlan) await applyPlanToRestaurant(restaurantId, enumPlan, periodEnd);
          break;
        }

        case "invoice.paid": {
          const inv = event.data.object as Stripe.Invoice;
          const restaurantId = await restaurantIdFromCustomer(inv.customer);
          if (!restaurantId) break;
          const periodEnd = inv.lines?.data?.[0]?.period?.end
            ? new Date(inv.lines.data[0].period.end * 1000)
            : new Date(Date.now() + 31 * 86400_000);
          await prisma.$executeRawUnsafe(
            `UPDATE "Restaurant" SET "subscriptionExpiresAt" = $1 WHERE id = $2`,
            periodEnd, restaurantId,
          );
          break;
        }

        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          const restaurantId = (sub.metadata?.restaurantId) || await restaurantIdFromCustomer(sub.customer);
          if (!restaurantId) break;
          const rows = await prisma.$queryRawUnsafe<Array<{ subscription: string; name: string }>>(
            `SELECT subscription::text AS subscription, name FROM "Restaurant" WHERE id = $1`, restaurantId,
          );
          const prev = rows[0];
          await prisma.$executeRawUnsafe(
            `UPDATE "Restaurant" SET "subscriptionExpiresAt" = CURRENT_TIMESTAMP, "platformStripeSubscriptionId" = NULL WHERE id = $1`,
            restaurantId,
          );
          await logSubEvent({
            restaurantId, restaurantName: prev?.name, type: "canceled",
            plan: prev?.subscription ?? "STARTER", mrrCents: 0,
            mrrDeltaCents: -(PLAN_MRR_CENTS[prev?.subscription ?? "STARTER"] ?? 0),
          });
          break;
        }
      }
    } catch (e) {
      console.error("[platformBilling] webhook handler error:", e);
    }

    return reply.send({ received: true });
  });

  /** Retrouve le restaurantId à partir d'un customer Stripe. */
  async function restaurantIdFromCustomer(customer: string | Stripe.Customer | Stripe.DeletedCustomer | null): Promise<string | null> {
    const cid = typeof customer === "string" ? customer : customer?.id;
    if (!cid) return null;
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "Restaurant" WHERE "platformStripeCustomerId" = $1 LIMIT 1`, cid,
    );
    return rows[0]?.id ?? null;
  }
}
