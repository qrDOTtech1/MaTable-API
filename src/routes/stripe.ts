import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireSessionToken } from "../auth.js";
import { env } from "../env.js";
import { emitToRestaurant } from "../realtime.js";
import { randomUUID } from "crypto";

// Cache Stripe instances per restaurant (key = secretKey)
const stripeCache = new Map<string, Stripe>();

function getStripeInstance(secretKey: string): Stripe {
  let instance = stripeCache.get(secretKey);
  if (!instance) {
    instance = new Stripe(secretKey);
    stripeCache.set(secretKey, instance);
  }
  return instance;
}

// Get Stripe keys for a restaurant (per-restaurant first, then global fallback)
export async function getStripeForRestaurant(restaurantId: string): Promise<{
  stripe: Stripe | null;
  webhookSecret: string | null;
}> {
  // Try per-restaurant keys
  type Row = { stripeSecretKey: string | null; stripeWebhookSecret: string | null };
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT "stripeSecretKey", "stripeWebhookSecret"
    FROM "Restaurant"
    WHERE id = ${restaurantId}
    LIMIT 1
  `;
  const row = rows[0];

  if (row?.stripeSecretKey) {
    return {
      stripe: getStripeInstance(row.stripeSecretKey),
      webhookSecret: row.stripeWebhookSecret ?? env.STRIPE_WEBHOOK_SECRET ?? null,
    };
  }

  // Fallback to global env
  if (env.STRIPE_SECRET) {
    return {
      stripe: getStripeInstance(env.STRIPE_SECRET),
      webhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    };
  }

  return { stripe: null, webhookSecret: null };
}

export async function stripeRoutes(app: FastifyInstance) {

  // ── POST /checkout — Google Pay + Apple Pay enabled ─────────────────────────
  app.post("/checkout", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);

    const { stripe } = await getStripeForRestaurant(decoded.restaurantId);
    if (!stripe) return reply.code(503).send({ error: "stripe_not_configured" });

    const { orderId } = z
      .object({ orderId: z.string().optional() })
      .default({})
      .parse(req.body ?? {});

    const sessionRow = await prisma.tableSession.findUnique({ where: { id: decoded.sessionId } });
    if (!sessionRow || !sessionRow.active) {
      return reply.code(401).send({ error: "session_closed" });
    }

    const orders = orderId
      ? await prisma.order.findMany({ where: { id: orderId, sessionId: decoded.sessionId } })
      : await prisma.order.findMany({
          where: {
            sessionId: decoded.sessionId,
            status: { notIn: ["PAID", "CANCELLED"] },
          },
          orderBy: { createdAt: "asc" },
        });

    if (!orders.length) {
      return reply.code(400).send({ error: orderId ? "order_not_found" : "nothing_to_pay" });
    }

    const itemsByKey = new Map<string, { name: string; priceCents: number; quantity: number }>();
    for (const o of orders) {
      const items = o.items as Array<{ name: string; priceCents: number; quantity: number }>;
      for (const it of items) {
        const key = `${it.name}__${it.priceCents}`;
        const prev = itemsByKey.get(key);
        if (prev) prev.quantity += it.quantity;
        else itemsByKey.set(key, { name: it.name, priceCents: it.priceCents, quantity: it.quantity });
      }
    }

    const mergedItems = Array.from(itemsByKey.values()).filter((i) => i.quantity > 0);
    if (!mergedItems.length) return reply.code(400).send({ error: "nothing_to_pay" });

    // payment_method_types not set = Stripe auto-enables card, Google Pay, Apple Pay, Link
    // based on what's activated in the Stripe Dashboard for this account
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      // Let Stripe auto-detect best payment methods (card + wallets)
      // This auto-enables Google Pay, Apple Pay, Link when available
      line_items: mergedItems.map((i) => ({
        quantity: i.quantity,
        price_data: {
          currency: "eur",
          product_data: { name: i.name },
          unit_amount: i.priceCents,
        },
      })),
      payment_method_options: {
        card: {
          // Request Google Pay / Apple Pay wallets on card
          setup_future_usage: undefined,
        },
      },
      success_url: `${env.PUBLIC_WEB_URL}/order/${decoded.tableId}?paid=1`,
      cancel_url: `${env.PUBLIC_WEB_URL}/order/${decoded.tableId}`,
      metadata: {
        orderId: orderId ?? "",
        sessionId: decoded.sessionId,
        tableId: decoded.tableId,
        restaurantId: decoded.restaurantId,
      },
    });
    return { url: session.url };
  });

  // ── POST /webhook — handles events from any restaurant's Stripe account ─────
  app.post(
    "/webhook",
    { config: { rawBody: true } },
    async (req, reply) => {
      const sig = req.headers["stripe-signature"] as string;
      if (!sig) return reply.code(400).send({ error: "missing_signature" });

      // We need to verify the webhook. Try global secret first, then per-restaurant.
      // For webhooks, the restaurantId is in the metadata AFTER verification, so we need
      // at least one valid webhook secret to verify.
      // Strategy: try global webhook secret, if that fails try all unique restaurant secrets.
      let event: Stripe.Event | null = null;

      // Try global env webhook secret first
      if (env.STRIPE_SECRET && env.STRIPE_WEBHOOK_SECRET) {
        try {
          const globalStripe = getStripeInstance(env.STRIPE_SECRET);
          event = globalStripe.webhooks.constructEvent(
            (req as any).rawBody, sig, env.STRIPE_WEBHOOK_SECRET,
          );
        } catch {}
      }

      // If global didn't work, try per-restaurant webhook secrets
      if (!event) {
        type WRow = { id: string; stripeSecretKey: string; stripeWebhookSecret: string };
        const restaurants = await prisma.$queryRaw<WRow[]>`
          SELECT id, "stripeSecretKey", "stripeWebhookSecret"
          FROM "Restaurant"
          WHERE "stripeSecretKey" IS NOT NULL AND "stripeWebhookSecret" IS NOT NULL
        `;

        for (const r of restaurants) {
          try {
            const s = getStripeInstance(r.stripeSecretKey);
            event = s.webhooks.constructEvent((req as any).rawBody, sig, r.stripeWebhookSecret);
            break; // Found the right one
          } catch {}
        }
      }

      if (!event) {
        return reply.code(400).send({ error: "bad_signature" });
      }

      if (event.type === "checkout.session.completed") {
        const s = event.data.object as Stripe.Checkout.Session;
        const metadataType = s.metadata?.type;
        const sessionId = s.metadata?.sessionId;
        const tableId = s.metadata?.tableId;
        const restaurantId = s.metadata?.restaurantId;

        if (metadataType === "tip" && restaurantId) {
          const amountCents = s.amount_total || 0;
          const serverId = s.metadata?.serverId || null;
          const serverName = s.metadata?.serverName || "L'équipe";
          
          try {
            await prisma.$executeRawUnsafe(
              `INSERT INTO "ServerTip" (id, "restaurantId", "serverId", "serverName", "amountCents", "stripeSessionId", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
              randomUUID(), restaurantId, serverId, serverName, amountCents, s.id
            );
          } catch (dbErr) {
            console.error("Error saving ServerTip:", dbErr);
          }
        } else if (sessionId && tableId) {
          await prisma.order.updateMany({
            where: { sessionId, status: { notIn: ["PAID", "CANCELLED"] } },
            data: { status: "PAID" },
          });
          await prisma.tableSession.update({
            where: { id: sessionId },
            data: { active: false, closedAt: new Date() },
          });

          if (restaurantId) {
            emitToRestaurant(restaurantId, "order:paid", { tableId });
          }
        }
      }
      return { received: true };
    }
  );

  // ── GET /stripe-config — return publishable key for frontend ────────────────
  app.get("/stripe-config/:restaurantId", async (req, reply) => {
    const { restaurantId } = req.params as { restaurantId: string };

    type Row = { stripePublicKey: string | null };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT "stripePublicKey"
      FROM "Restaurant"
      WHERE id = ${restaurantId}
      LIMIT 1
    `;

    const pk = rows[0]?.stripePublicKey ?? env.STRIPE_PUBLIC_KEY ?? null;
    if (!pk) return reply.code(503).send({ error: "stripe_not_configured" });
    return { publishableKey: pk };
  });
}
