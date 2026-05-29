import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../db.js";
import { requirePro } from "../auth.js";
import { emitToRestaurant, emitToSession } from "../realtime.js";
import { registerSseClient, unregisterSseClient } from "../sseHub.js";
import { getEnabledApps } from "../appGating.js";
import { parseQuantityDiscounts, effectiveUnitPriceCents } from "../quantityDiscount.js";
import { parseQuantityTiers } from "../quantityTiers.js";

const ALLERGENS = [
  "GLUTEN","CRUSTACEANS","EGGS","FISH","PEANUTS","SOYBEANS","MILK","NUTS",
  "CELERY","MUSTARD","SESAME","SULPHITES","LUPIN","MOLLUSCS",
] as const;
const DIETS = [
  "VEGETARIAN","VEGAN","GLUTEN_FREE","LACTOSE_FREE","HALAL","KOSHER",
  "PORK_FREE","LOW_CAL","SPICY",
] as const;

function generatePassword(length = 12): string {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(length)))
    .map((b) => chars[b % chars.length])
    .join("");
}

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
   .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export async function proRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/register", authRateLimit, async (req, reply) => {
    const parsed = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      restaurantName: z.string().min(1),
      referralCode: z.string().trim().min(3).max(40).optional(),
    }).parse(req.body);
    // Normalise l'email (casse/espaces) — sinon une inscription "John@X.com"
    // ne matche pas le login qui cherche en lowercase → impossible de se connecter.
    const email = parsed.email.trim().toLowerCase();
    const { password, restaurantName, referralCode: refCodeRaw } = parsed;
    const referredByCode = refCodeRaw?.toUpperCase().trim() || null;

    // Vérifie que le code de parrainage existe vraiment (sinon on l'ignore en silence)
    let validReferrer = false;
    if (referredByCode) {
      try {
        const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT id FROM "Restaurant" WHERE "referralCode" = $1 LIMIT 1`, referredByCode,
        );
        validReferrer = rows.length > 0;
      } catch { /* colonne absente → on ignore */ }
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return reply.code(409).send({ error: "email_exists" });

    const base = slugify(restaurantName) || "resto";
    let slug = base, i = 1;
    while (await prisma.restaurant.findUnique({ where: { slug } })) slug = `${base}-${++i}`;

    const passwordHash = await bcrypt.hash(password, 10);
    // Nouveau compte = forfait PRO en version d'essai (14 j) — apps PRO activées.
    // L'essai reste affiché tant qu'aucune facture n'est encaissée (cf. /status).
    const TRIAL_DAYS = 14;
    const now = new Date();
    const trialEnds = new Date(now.getTime() + TRIAL_DAYS * 24 * 3600 * 1000);
    const { restaurant } = await prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({
        data: {
          name: restaurantName,
          slug,
          subscription: "PRO",
          subscriptionStartedAt: now,
          subscriptionExpiresAt: trialEnds,
        },
      });
      await tx.user.create({ data: { email, passwordHash, restaurantId: restaurant.id } });
      // enabledApps (hors schéma Prisma) — plan PRO : avis + réservations + commandes
      await tx.$executeRawUnsafe(
        `UPDATE "Restaurant" SET "enabledApps" = $1::jsonb WHERE id = $2`,
        JSON.stringify(["reviews", "reservations", "orders"]), restaurant.id,
      );

      // Code parrainage unique pour ce resto (tente plusieurs fois en cas de collision)
      const baseSlug = (slugify(restaurantName) || "RESTO").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4) || "RESTO";
      const randPart = () => Math.random().toString(36).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4).padEnd(4, "X");
      let myRefCode: string | null = null;
      for (let attempt = 0; attempt < 5 && !myRefCode; attempt++) {
        const candidate = `${baseSlug}-${randPart()}`;
        try {
          await tx.$executeRawUnsafe(
            `UPDATE "Restaurant" SET "referralCode" = $1 WHERE id = $2`, candidate, restaurant.id,
          );
          myRefCode = candidate;
        } catch { /* collision unique → on retente */ }
      }
      // Si parrainage valide, l'enregistrer sur le resto
      if (validReferrer && referredByCode) {
        try {
          await tx.$executeRawUnsafe(
            `UPDATE "Restaurant" SET "referredByCode" = $1 WHERE id = $2`, referredByCode, restaurant.id,
          );
        } catch { /* colonne absente → on ignore */ }
      }
      return { restaurant };
    });
    return { ok: true, restaurantId: restaurant.id, slug };
  });

   app.post("/login", authRateLimit, async (req, reply) => {
    // Lenient validation — don't crash on slightly invalid emails
    const body = req.body as Record<string, unknown> ?? {};
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");

    if (!email || !password || password.length < 6) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.restaurantId) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    // Support both passwordHash (pro register) and password (RSMATABLE register)
    const hash = user.passwordHash ?? user.password;
    if (!hash) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const matches = await bcrypt.compare(password, hash);
    if (!matches) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const token = app.jwt.sign(
      { kind: "pro", userId: user.id, restaurantId: user.restaurantId },
      { expiresIn: "7d" }
    );
    return { ok: true, token, restaurantId: user.restaurantId };
  });

  app.post("/logout", async () => ({ ok: true }));

  // POST /forgot-password — envoie un mot de passe temporaire par email (sans auth)
  app.post("/forgot-password", authRateLimit, async (req, reply) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);

    const user = await prisma.user.findFirst({
      where: { email: email.trim().toLowerCase() },
      include: { restaurant: { select: { name: true, slug: true } } },
    });

    // Toujours répondre OK pour ne pas révéler si l'email existe
    if (!user) return { ok: true };

    const tmpPassword = generatePassword(10);
    const passwordHash = await bcrypt.hash(tmpPassword, 10);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

    const { sendEmail } = await import("../email.js");
    if (!user.email) {
      return reply.code(400).send({ error: "no_email", message: "Cet utilisateur n'a pas d'email enregistré." });
    }
    await sendEmail({
      to: user.email,
      subject: "🔑 Réinitialisation de votre mot de passe MaTable.Pro",
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;background:#0f172a;color:#e2e8f0;padding:32px;border-radius:12px">
          <h2 style="color:#f97316;margin-bottom:8px">🍽️ MaTable.Pro</h2>
          <h3 style="color:#fff;margin-bottom:24px">Mot de passe temporaire</h3>
          <p style="color:#94a3b8;margin-bottom:24px">
            Bonjour,<br>
            Vous avez demandé la réinitialisation de votre mot de passe.<br>
            Voici votre mot de passe temporaire :
          </p>
          <div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:20px;margin-bottom:24px">
            <p style="margin:0 0 8px;color:#94a3b8;font-size:13px">Email</p>
            <p style="margin:0 0 16px;color:#fff;font-family:monospace;font-size:15px">${user.email}</p>
            <p style="margin:0 0 8px;color:#94a3b8;font-size:13px">Mot de passe temporaire</p>
            <p style="margin:0;color:#f97316;font-family:monospace;font-size:22px;font-weight:bold;letter-spacing:2px">${tmpPassword}</p>
          </div>
          ${user.restaurant ? `<a href="https://matable.pro/login" style="display:inline-block;background:#f97316;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold">Se connecter →</a>` : ""}
          <p style="color:#475569;font-size:12px;margin-top:24px">
            Connectez-vous puis changez ce mot de passe depuis vos <strong>Paramètres</strong>.<br>
            Si vous n'avez pas fait cette demande, ignorez cet email.
          </p>
        </div>
      `,
    });

    return { ok: true };
  });

  // GET /referrals/me — code de parrainage + liste des filleuls
  app.get("/referrals/me", async (req, reply) => {
    const me = await requirePro(req, reply);
    try {
      const meRows = await prisma.$queryRawUnsafe<Array<{ referralCode: string | null }>>(
        `SELECT "referralCode" FROM "Restaurant" WHERE id = $1`, me.restaurantId,
      );
      const code = meRows[0]?.referralCode ?? null;

      type Referee = { id: string; name: string; createdAt: Date; referralRewardGranted: boolean; subscriptionStartedAt: Date | null };
      const referees = code ? await prisma.$queryRawUnsafe<Referee[]>(
        `SELECT id, name, "createdAt", "referralRewardGranted", "subscriptionStartedAt"
           FROM "Restaurant"
          WHERE "referredByCode" = $1
          ORDER BY "createdAt" DESC`, code,
      ) : [];

      // "Converti" si une facture payante existe pour ce filleul
      const ids = referees.map((r) => r.id);
      let paidSet = new Set<string>();
      if (ids.length > 0) {
        try {
          const rows = await prisma.$queryRawUnsafe<Array<{ restaurantId: string }>>(
            `SELECT DISTINCT "restaurantId" FROM "SubscriptionEvent" WHERE "restaurantId" = ANY($1::text[]) AND "amountCents" > 0`,
            ids,
          );
          paidSet = new Set(rows.map((r) => r.restaurantId));
        } catch { /* table absente */ }
      }

      const referrals = referees.map((r) => ({
        name: r.name,
        createdAt: r.createdAt,
        converted: paidSet.has(r.id),
        rewardGranted: r.referralRewardGranted,
      }));
      const totalConverted = referrals.filter((r) => r.converted).length;
      const totalRewardMonths = referrals.filter((r) => r.rewardGranted).length; // 1 mois par récompense

      return { code, referrals, totalConverted, totalRewardMonths };
    } catch {
      return { code: null, referrals: [], totalConverted: 0, totalRewardMonths: 0 };
    }
  });

  // PATCH /account/password — change own password (client logged in)
  app.patch("/account/password", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(6),
    }).parse(req.body);

    const user = await prisma.user.findUnique({ where: { id: me.userId } });
    if (!user) return reply.code(404).send({ error: "not_found" });

    const hash = user.passwordHash ?? (user as any).password;
    if (!hash) return reply.code(401).send({ error: "no_password_set" });

    const matches = await bcrypt.compare(currentPassword, hash);
    if (!matches) return reply.code(401).send({ error: "wrong_current_password" });

    const newHash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: me.userId }, data: { passwordHash: newHash } });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Testimonial (vitrine publique)
  // ---------------------------------------------------------------------------
  app.get("/testimonial", async (req, reply) => {
    const me = await requirePro(req, reply);
    const testimonial = await prisma.testimonial.findUnique({
      where: { restaurantId: me.restaurantId },
    });
    return { testimonial };
  });

  app.put("/testimonial", async (req, reply) => {
    const me = await requirePro(req, reply);
    const data = z.object({
      displayName: z.string().min(1).max(80),
      displayRole: z.string().max(120).optional(),
      quote: z.string().min(20).max(600),
      rating: z.number().int().min(1).max(5).default(5),
      published: z.boolean().default(true),
    }).parse(req.body);

    const testimonial = await prisma.testimonial.upsert({
      where: { restaurantId: me.restaurantId },
      create: { restaurantId: me.restaurantId, ...data, displayRole: data.displayRole?.trim() || undefined },
      update: { ...data, displayRole: data.displayRole?.trim() || undefined },
    });
    return { testimonial };
  });

   // ---------------------------------------------------------------------------
   // Upload image (stockage Postgres via Media) - for general use
   // ---------------------------------------------------------------------------
   app.post("/uploads/image", async (req, reply) => {
     const me = await requirePro(req, reply);
     const part = await (req as any).file();
     if (!part) return reply.code(400).send({ error: "missing_file" });
     if (typeof part.mimetype !== "string" || !part.mimetype.startsWith("image/"))
       return reply.code(400).send({ error: "invalid_mime" });
     const buf: Buffer = await part.toBuffer();
     if (!buf.length) return reply.code(400).send({ error: "empty_file" });
     const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
     const media = await prisma.media.create({
       data: {
         restaurantId: me.restaurantId,
         mimeType: part.mimetype,
         bytes: buf,
         size: buf.length,
         originalName: part.filename,
         sha256,
       },
     });
     return { id: media.id, path: `/api/media/${media.id}` };
   });

   // ---------------------------------------------------------------------------
   // Upload restaurant photo (for slideshow on public page and social app)
   // ---------------------------------------------------------------------------
   app.post("/uploads/restaurant-photo", async (req, reply) => {
     const me = await requirePro(req, reply);
     const part = await (req as any).file();
     if (!part) return reply.code(400).send({ error: "missing_file" });
     if (typeof part.mimetype !== "string" || !part.mimetype.startsWith("image/"))
       return reply.code(400).send({ error: "invalid_mime" });
     const buf: Buffer = await part.toBuffer();
     if (!buf.length) return reply.code(400).send({ error: "empty_file" });
     const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
     const photo = await prisma.photo.create({
       data: {
         restaurantId: me.restaurantId,
         mimeType: part.mimetype,
         bytes: buf,
         size: buf.length,
         originalName: part.filename,
         sha256,
       },
     });
     return { id: photo.id, path: `/api/photo/${photo.id}` };
   });

  // ───────────────────────────────────────────────────────────────────────
  // GET /api/pro/events/stream — Server-Sent Events
  // Stream temps reel pour les terminaux NovaOS et autres clients headless.
  // Authentifie via JWT pro (header Authorization OU ?token=... query string,
  // car le constructeur EventSource ne permet pas de header custom).
  // ───────────────────────────────────────────────────────────────────────
  app.get<{ Querystring: { token?: string } }>("/events/stream", async (req, reply) => {
    // Allow token via query string for EventSource compatibility
    const q = req.query;
    if (q?.token && !req.headers.authorization) {
      (req.headers as any).authorization = `Bearer ${q.token}`;
    }

    const me = await requirePro(req, reply);
    if (!me) return; // requirePro already sent 401

    const client = registerSseClient(me.restaurantId, reply);

    // Cleanup on disconnect
    req.raw.on("close", () => {
      unregisterSseClient(me.restaurantId, client);
    });
    req.raw.on("error", () => {
      unregisterSseClient(me.restaurantId, client);
    });

    // Fastify expects us to return — but we hijack the reply for SSE.
    // Mark as hijacked so Fastify doesn't try to serialize a response.
    return reply.hijack();
  });

  app.get("/me", async (req, reply) => {
    const me = await requirePro(req, reply);
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      include: { openingHours: { orderBy: [{ dayOfWeek: "asc" }, { openMin: "asc" }] } },
    });
    
    if (restaurant) {
      const configRaw = await prisma.$queryRawUnsafe<any[]>(
        `SELECT "googleReviewLink", "reviewVoucherConfig", "businessType", "reviewCustomQuestions", "serverUniqueReviewQr", "reviewRatingCategories", "reservationAlertEmail", "reservationAlertEmails" FROM "Restaurant" WHERE id = $1`, me.restaurantId
      );
      (restaurant as any).googleReviewLink = configRaw[0]?.googleReviewLink || null;
      (restaurant as any).reviewVoucherConfig = configRaw[0]?.reviewVoucherConfig || null;
      (restaurant as any).businessType = configRaw[0]?.businessType || "RESTAURANT";
      (restaurant as any).reviewCustomQuestions = configRaw[0]?.reviewCustomQuestions || null;
      (restaurant as any).serverUniqueReviewQr = configRaw[0]?.serverUniqueReviewQr ?? true;
      (restaurant as any).reviewRatingCategories = Array.isArray(configRaw[0]?.reviewRatingCategories) ? configRaw[0].reviewRatingCategories : [];
      (restaurant as any).reservationAlertEmail = configRaw[0]?.reservationAlertEmail ?? null;
      (restaurant as any).reservationAlertEmails = Array.isArray(configRaw[0]?.reservationAlertEmails)
        ? configRaw[0].reservationAlertEmails
        : (configRaw[0]?.reservationAlertEmail ? [configRaw[0].reservationAlertEmail] : []);

      // dashboardQuickActions + dashboardBottomNav + onboardingCompleted — requête isolée (colonnes ajoutées par migration, peuvent ne pas exister)
      try {
        const qaRaw = await prisma.$queryRawUnsafe<any[]>(
          `SELECT "dashboardQuickActions", "dashboardBottomNav", "onboardingCompleted" FROM "Restaurant" WHERE id = $1`, me.restaurantId
        );
        (restaurant as any).dashboardQuickActions = Array.isArray(qaRaw[0]?.dashboardQuickActions)
          ? qaRaw[0].dashboardQuickActions
          : [];
        (restaurant as any).dashboardBottomNav = Array.isArray(qaRaw[0]?.dashboardBottomNav)
          ? qaRaw[0].dashboardBottomNav
          : [];
        (restaurant as any).onboardingCompleted = qaRaw[0]?.onboardingCompleted ?? false;
      } catch {
        (restaurant as any).dashboardQuickActions = [];
        (restaurant as any).dashboardBottomNav = [];
        (restaurant as any).onboardingCompleted = true; // si colonne absente, ne pas re-trigger l'onboarding
      }
    }

    const enabledApps = await getEnabledApps(me.restaurantId);
    
    return { userId: me.userId, restaurant, enabledApps: [...enabledApps] };
  });

  // ---------------------------------------------------------------------------
  // Restaurant settings
  // ---------------------------------------------------------------------------
  app.patch("/restaurant", async (req, reply) => {
    const me = await requirePro(req, reply);
    const body = z.object({
      name: z.string().min(1).optional(),
      slug: z.string().min(3).max(60).regex(/^[a-z0-9-]+$/).optional(),
      description: z.string().max(2000).optional(),
      address: z.string().optional(),
      city: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      website: z.string().url().optional(),
      isPartner: z.boolean().optional(),
      acceptReservations: z.boolean().optional(),
      avgPrepMinutes: z.number().int().min(30).max(300).optional(),
      reservationLeadMinutes: z.number().int().min(0).max(2880).optional(),
      depositPerGuestCents: z.number().int().min(0).optional(),
      reservationPolicy: z.string().max(2000).optional(),
      reservationAlertEmail: z.string().email().optional().nullable(),
      reservationAlertEmails: z.array(z.string().email()).max(10).optional(),
      maxCoversPerSlot: z.number().int().min(0).nullable().optional(),
      dashboardQuickActions: z.array(z.string().min(1).max(120)).max(8).optional(),
      dashboardBottomNav: z.array(z.string().min(1).max(120)).max(5).optional(),
      onboardingCompleted: z.boolean().optional(),
      reservationSlotMinutes: z.number().int().min(10).max(120).optional(),
      tipsEnabled: z.boolean().optional(),
      serviceCallEnabled: z.boolean().optional(),
      reviewsEnabled: z.boolean().optional(),
      serverUniqueReviewQr: z.boolean().optional(),
      googleReviewLink: z.string().optional().nullable(),
      reviewVoucherConfig: z.any().optional(),
      businessType: z.enum(["RESTAURANT", "BOUTIQUE"]).optional(),
      reviewCustomQuestions: z.string().max(2000).optional().nullable(),
      reviewRatingCategories: z.array(z.object({
        key: z.string().min(1).max(40).regex(/^[a-z0-9_]+$/i, "key must be alphanumeric/underscore"),
        label: z.string().min(1).max(60),
        icon: z.string().max(8).optional().default(""),
        enabled: z.boolean().optional().default(true),
      })).max(12).optional(),
      openingHours: z.array(z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        openMin: z.number().int().min(0).max(1440),
        closeMin: z.number().int().min(0).max(1440),
        service: z.string().nullable().optional(),
      })).optional(),
    }).parse(req.body);

    const { openingHours, googleReviewLink, reviewVoucherConfig, businessType, reviewCustomQuestions, reviewRatingCategories, reservationAlertEmail, reservationAlertEmails, maxCoversPerSlot, dashboardQuickActions, dashboardBottomNav, onboardingCompleted, ...restData } = body;

    if (restData.slug) {
      const taken = await prisma.restaurant.findFirst({
        where: { slug: restData.slug, NOT: { id: me.restaurantId } },
      });
      if (taken) return reply.code(409).send({ error: "slug_taken" });
    }

    const ops: any[] = [
      prisma.restaurant.update({ where: { id: me.restaurantId }, data: restData }),
    ];
    
    // Update review campaign fields if provided (outside of Prisma typed schema)
    if (googleReviewLink !== undefined) {
      ops.push(prisma.$executeRawUnsafe(`UPDATE "Restaurant" SET "googleReviewLink" = $1 WHERE id = $2`, googleReviewLink, me.restaurantId));
    }
    if (reviewVoucherConfig !== undefined) {
      ops.push(prisma.$executeRawUnsafe(`UPDATE "Restaurant" SET "reviewVoucherConfig" = $1::jsonb WHERE id = $2`, JSON.stringify(reviewVoucherConfig || {}), me.restaurantId));
    }
    if (businessType !== undefined) {
      ops.push(prisma.$executeRawUnsafe(`UPDATE "Restaurant" SET "businessType" = $1 WHERE id = $2`, businessType, me.restaurantId));
    }
    if (reservationAlertEmail !== undefined) {
      ops.push(prisma.$executeRawUnsafe(`UPDATE "Restaurant" SET "reservationAlertEmail" = $1 WHERE id = $2`, reservationAlertEmail, me.restaurantId));
    }
    if (maxCoversPerSlot !== undefined) {
      ops.push(prisma.$executeRawUnsafe(`UPDATE "Restaurant" SET "maxCoversPerSlot" = $1 WHERE id = $2`, maxCoversPerSlot, me.restaurantId));
    }
    if (dashboardQuickActions !== undefined) {
      const cleaned = Array.from(new Set(dashboardQuickActions.map(h => h.trim()).filter(Boolean))).slice(0, 8);
      ops.push(prisma.$executeRawUnsafe(
        `UPDATE "Restaurant" SET "dashboardQuickActions" = $1::jsonb WHERE id = $2`,
        JSON.stringify(cleaned), me.restaurantId
      ));
    }
    if (dashboardBottomNav !== undefined) {
      const cleaned = Array.from(new Set(dashboardBottomNav.map(h => h.trim()).filter(Boolean))).slice(0, 5);
      ops.push(prisma.$executeRawUnsafe(
        `UPDATE "Restaurant" SET "dashboardBottomNav" = $1::jsonb WHERE id = $2`,
        JSON.stringify(cleaned), me.restaurantId
      ));
    }
    if (onboardingCompleted !== undefined) {
      ops.push(prisma.$executeRawUnsafe(
        `UPDATE "Restaurant" SET "onboardingCompleted" = $1 WHERE id = $2`,
        onboardingCompleted, me.restaurantId
      ));
    }
    if (reservationAlertEmails !== undefined) {
      const cleaned = Array.from(new Set(reservationAlertEmails.map(e => e.trim().toLowerCase()).filter(Boolean))).slice(0, 10);
      ops.push(prisma.$executeRawUnsafe(
        `UPDATE "Restaurant" SET "reservationAlertEmails" = $1::jsonb, "reservationAlertEmail" = $2 WHERE id = $3`,
        JSON.stringify(cleaned), cleaned[0] ?? null, me.restaurantId
      ));
    }
    if (reviewCustomQuestions !== undefined) {
      ops.push(prisma.$executeRawUnsafe(`UPDATE "Restaurant" SET "reviewCustomQuestions" = $1 WHERE id = $2`, reviewCustomQuestions, me.restaurantId));
    }
    if (reviewRatingCategories !== undefined) {
      // Dedupe by key, keep order
      const seen = new Set<string>();
      const cleaned = reviewRatingCategories.filter(c => {
        const k = c.key.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      ops.push(prisma.$executeRawUnsafe(`UPDATE "Restaurant" SET "reviewRatingCategories" = $1::jsonb WHERE id = $2`, JSON.stringify(cleaned), me.restaurantId));
    }
    if (openingHours !== undefined) {
      ops.push(prisma.openingHour.deleteMany({ where: { restaurantId: me.restaurantId } }));
      if (openingHours.length > 0) {
        ops.push(prisma.openingHour.createMany({
          data: openingHours.map((h) => ({ ...h, restaurantId: me.restaurantId })),
        }));
      }
    }
    const [restaurant] = await prisma.$transaction(ops);

    // Auto-géocodage : quand l'adresse/ville change → mise à jour mapLat/mapLng (Nominatim, non-bloquant)
    if (restData.address !== undefined || restData.city !== undefined) {
      const q = [restData.address, restData.city].filter(Boolean).join(", ");
      if (q) {
        fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`,
          { headers: { "User-Agent": "MaTable-Pro/1.0 contact@matable.pro" } }
        )
          .then((r) => r.json())
          .then((data: any[]) => {
            if (data.length > 0) {
              const lat = parseFloat(data[0].lat);
              const lng = parseFloat(data[0].lon);
              if (!isNaN(lat) && !isNaN(lng)) {
                prisma
                  .$executeRawUnsafe(
                    `UPDATE "Restaurant" SET "mapLat" = $1, "mapLng" = $2 WHERE id = $3`,
                    lat,
                    lng,
                    me.restaurantId
                  )
                  .catch(() => {});
              }
            }
          })
          .catch(() => {});
      }
    }

    return { restaurant };
  });

  // ---------------------------------------------------------------------------
  // Service PINs (caisse + cuisine) — manager self-service
  // ---------------------------------------------------------------------------
  app.patch("/service-pins", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { caissePin, cuisinePin } = z.object({
      caissePin:  z.union([z.string().regex(/^\d{4,8}$/), z.null()]).optional(),
      cuisinePin: z.union([z.string().regex(/^\d{4,8}$/), z.null()]).optional(),
    }).parse(req.body);

    const updates: Record<string, string | null> = {};
    if (caissePin  !== undefined) updates.caissePin  = caissePin;
    if (cuisinePin !== undefined) updates.cuisinePin = cuisinePin;

    if (Object.keys(updates).length === 0) return { ok: true };

    // Use raw SQL since columns may not be in generated client yet
    if (updates.caissePin !== undefined) {
      if (updates.caissePin) {
        await prisma.$executeRaw`UPDATE "Restaurant" SET "caissePin" = ${updates.caissePin} WHERE id = ${me.restaurantId}`;
      } else {
        await prisma.$executeRaw`UPDATE "Restaurant" SET "caissePin" = NULL WHERE id = ${me.restaurantId}`;
      }
    }
    if (updates.cuisinePin !== undefined) {
      if (updates.cuisinePin) {
        await prisma.$executeRaw`UPDATE "Restaurant" SET "cuisinePin" = ${updates.cuisinePin} WHERE id = ${me.restaurantId}`;
      } else {
        await prisma.$executeRaw`UPDATE "Restaurant" SET "cuisinePin" = NULL WHERE id = ${me.restaurantId}`;
      }
    }

    return { ok: true };
  });

  app.get("/service-pins", async (req, reply) => {
    const me = await requirePro(req, reply);
    const rows = await prisma.$queryRaw<Array<{ caissePin: string | null; cuisinePin: string | null }>>`
      SELECT "caissePin", "cuisinePin" FROM "Restaurant" WHERE id = ${me.restaurantId}
    `;
    return {
      caissePinSet:  !!rows[0]?.caissePin,
      cuisinePinSet: !!rows[0]?.cuisinePin,
      // Return actual PIN only so manager can see/update it
      caissePin:  rows[0]?.caissePin ?? null,
      cuisinePin: rows[0]?.cuisinePin ?? null,
    };
  });

  // ---------------------------------------------------------------------------
  // Opening hours
  // ---------------------------------------------------------------------------
  app.get("/opening-hours", async (req, reply) => {
    const me = await requirePro(req, reply);
    const hours = await prisma.openingHour.findMany({
      where: { restaurantId: me.restaurantId },
      orderBy: [{ dayOfWeek: "asc" }, { openMin: "asc" }],
    });
    return { hours };
  });

  app.put("/opening-hours", async (req, reply) => {
    const me = await requirePro(req, reply);
    const body = z.object({
      hours: z.array(z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        openMin: z.number().int().min(0).max(1440),
        closeMin: z.number().int().min(0).max(1440),
        service: z.string().nullable().optional(),
      })),
    }).parse(req.body);
    await prisma.openingHour.deleteMany({ where: { restaurantId: me.restaurantId } });
    if (body.hours.length)
      await prisma.openingHour.createMany({
        data: body.hours.map((h) => ({ ...h, restaurantId: me.restaurantId })),
      });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Tables
  // ---------------------------------------------------------------------------
  app.get("/tables", async (req, reply) => {
    const me = await requirePro(req, reply);
    const tables = await prisma.table.findMany({
      where: { restaurantId: me.restaurantId },
      orderBy: { number: "asc" },
      include: { sessions: { where: { active: true }, take: 1, include: { server: true } } },
    });
    return { tables };
  });

  app.post("/tables", async (req, reply) => {
    const me = await requirePro(req, reply);
    const body = z.object({
      seats: z.number().int().min(1).max(20).optional(),
      label: z.string().max(40).optional(),
      zone: z.string().max(40).optional(),
      assignedServerId: z.string().nullable().optional(),
      reservable: z.boolean().optional(),
    }).default({}).parse(req.body ?? {});
    const last = await prisma.table.findFirst({
      where: { restaurantId: me.restaurantId },
      orderBy: { number: "desc" },
    });
    const table = await prisma.table.create({
      data: {
        number: (last?.number ?? 0) + 1,
        restaurantId: me.restaurantId,
        seats: body.seats ?? 2,
        label: body.label,
        zone: body.zone,
        assignedServerId: body.assignedServerId ?? null,
        reservable: body.reservable ?? true,
      },
    });
    return { table };
  });

  app.patch("/tables/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const data = z.object({
      seats: z.number().int().min(1).max(20).optional(),
      label: z.string().max(40).nullable().optional(),
      zone: z.string().max(40).nullable().optional(),
      assignedServerId: z.string().nullable().optional(),
      reservable: z.boolean().optional(),
    }).parse(req.body);
    await prisma.table.updateMany({ where: { id, restaurantId: me.restaurantId }, data });
    return { ok: true };
  });

  app.delete("/tables/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    await prisma.table.deleteMany({ where: { id, restaurantId: me.restaurantId } });
    return { ok: true };
  });

  app.get("/zones", async (req, reply) => {
    const me = await requirePro(req, reply);
    const rows = await prisma.table.findMany({
      where: { restaurantId: me.restaurantId, zone: { not: null } },
      select: { zone: true },
      distinct: ["zone"],
    });
    return { zones: rows.map((r) => r.zone).filter(Boolean) };
  });

  // ── Zone configs (quotas walk-in) ──────────────────────────────────────────

  /** GET /zone-configs — liste tous les quotas du restaurant */
  app.get("/zone-configs", async (req, reply) => {
    const me = await requirePro(req, reply);
    const configs = await (prisma as any).zoneConfig.findMany({
      where: { restaurantId: me.restaurantId },
      orderBy: { zone: "asc" },
    });
    return { configs };
  });

  /** PUT /zone-configs/:zone — crée ou met à jour le quota walk-in d'une zone */
  app.put("/zone-configs/:zone", async (req, reply) => {
    const me = await requirePro(req, reply);
    const zone = decodeURIComponent((req.params as { zone: string }).zone);
    const { minFreeWalkIn } = z.object({
      minFreeWalkIn: z.number().int().min(0).max(50),
    }).parse(req.body);

    // Vérifier que la zone existe bien dans les tables du restaurant
    const exists = await prisma.table.findFirst({
      where: { restaurantId: me.restaurantId, zone },
    });
    if (!exists) return reply.code(404).send({ error: "zone_not_found" });

    const config = await (prisma as any).zoneConfig.upsert({
      where: { restaurantId_zone: { restaurantId: me.restaurantId, zone } },
      create: { restaurantId: me.restaurantId, zone, minFreeWalkIn },
      update: { minFreeWalkIn },
    });
    return { config };
  });

  /** DELETE /zone-configs/:zone — supprime la config walk-in d'une zone (quota → 0) */
  app.delete("/zone-configs/:zone", async (req, reply) => {
    const me = await requirePro(req, reply);
    const zone = decodeURIComponent((req.params as { zone: string }).zone);
    await (prisma as any).zoneConfig.deleteMany({
      where: { restaurantId: me.restaurantId, zone },
    });
    return { ok: true };
  });

  app.post("/tables/:id/reset", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const table = await prisma.table.findFirst({ where: { id, restaurantId: me.restaurantId } });
    if (!table) return reply.code(404).send({ error: "not_found" });
    await prisma.tableSession.updateMany({ where: { tableId: id, active: true }, data: { active: false, closedAt: new Date() } });
    return { ok: true };
  });

  app.post("/tables/:id/settle", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { mode } = z.object({ mode: z.enum(["CASH", "COUNTER"]).optional() }).parse(req.body ?? {});
    const table = await prisma.table.findFirst({
      where: { id, restaurantId: me.restaurantId },
      include: { sessions: { where: { active: true }, take: 1 } },
    });
    if (!table) return reply.code(404).send({ error: "not_found" });
    const session = table.sessions[0];
    if (!session) return reply.code(400).send({ error: "no_active_session" });
    await prisma.order.updateMany({
      where: { sessionId: session.id, status: { notIn: ["PAID", "CANCELLED"] } },
      data: { status: "PAID" },
    });
    await prisma.tableSession.update({
      where: { id: session.id },
      data: {
        active: false, closedAt: new Date(),
        billRequestedAt: session.billRequestedAt ?? new Date(),
        billPaymentMode: (mode ?? session.billPaymentMode ?? "COUNTER") as any,
      },
    });
    emitToRestaurant(me.restaurantId, "order:paid", { tableId: id });

    // ── Attribution automatique de points fidélité + ticket email ───────────
    try {
      const loyaltyConfig = await prisma.$queryRawUnsafe<Array<{
        enabled: boolean; ptsPerEuro: number; minSpendCents: number;
      }>>(
        `SELECT enabled, "ptsPerEuro", "minSpendCents" FROM "LoyaltyConfig"
         WHERE "restaurantId" = $1 LIMIT 1`,
        me.restaurantId
      );

      // Données de la session (email, téléphone, client fidélité lié)
      const sessionData = await prisma.$queryRawUnsafe<Array<{
        customerEmail: string | null;
        customerPhone: string | null;
        loyaltyCustomerId: string | null;
        customerName: string | null;
      }>>(
        `SELECT "customerEmail", "customerPhone", "loyaltyCustomerId", "customerName"
         FROM "TableSession" WHERE id = $1`,
        session.id
      );
      const sess = sessionData[0];

      // Calculer le total + récupérer les articles
      const orderRows = await prisma.$queryRawUnsafe<Array<{
        totalCents: number;
        itemName: string;
        qty: number;
        unitCents: number;
      }>>(
        `SELECT COALESCE(SUM(oi.quantity * oi."unitPriceCents"),0) AS "totalCents",
                oi.name AS "itemName", SUM(oi.quantity)::int AS qty,
                oi."unitPriceCents" AS "unitCents"
         FROM "Order" o
         JOIN "OrderItem" oi ON oi."orderId" = o.id
         WHERE o."sessionId" = $1 AND o.status NOT IN ('CANCELLED')
         GROUP BY oi.name, oi."unitPriceCents"`,
        session.id
      );
      const totalCents = Number(orderRows[0]?.totalCents ?? 0);

      // ── Fidélité ──────────────────────────────────────────────────────────
      let earnedPoints = 0;
      let loyaltyCustomer: { id: string; points: number; tier: string; firstName: string | null } | null = null;

      if (loyaltyConfig[0]?.enabled && totalCents >= (loyaltyConfig[0].minSpendCents ?? 0)) {
        const ptsEarned = Math.floor((totalCents / 100) * loyaltyConfig[0].ptsPerEuro);
        if (ptsEarned > 0) {
          // Priorité 1 : client déjà lié à la session via email/téléphone
          let loyaltyId = sess?.loyaltyCustomerId ?? null;

          // Priorité 2 : chercher par email ou téléphone de la session
          if (!loyaltyId && (sess?.customerEmail || sess?.customerPhone)) {
            const term = (sess.customerEmail || sess.customerPhone || "").trim().toLowerCase();
            const found = await prisma.$queryRawUnsafe<Array<{ id: string; points: number; tier: string; firstName: string | null }>>(
              `SELECT id, points, tier, "firstName" FROM "LoyaltyCustomer"
               WHERE "restaurantId" = $1
               AND (LOWER(COALESCE(email,'')) = $2
                    OR REPLACE(REPLACE(COALESCE(phone,''),' ',''),'.','') LIKE $3)
               LIMIT 1`,
              me.restaurantId, term, `%${term.replace(/[\s.+\-()]/g, "")}%`
            );
            if (found[0]) loyaltyId = found[0].id;

            // Priorité 3 : créer automatiquement si email connu mais pas encore inscrit
            if (!loyaltyId && sess?.customerEmail) {
              const name = (sess.customerName ?? "").split(" ");
              const newId = `lc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              await prisma.$executeRawUnsafe(
                `INSERT INTO "LoyaltyCustomer" (id, "restaurantId", "firstName", "lastName", email, phone, points, tier, "totalSpent", "visitCount", source, "createdAt", "updatedAt")
                 VALUES ($1,$2,$3,$4,$5,$6,0,'bronze',0,0,'order',NOW(),NOW())`,
                newId, me.restaurantId, name[0] ?? null, name[1] ?? null,
                sess.customerEmail.toLowerCase(), sess.customerPhone ?? null
              );
              loyaltyId = newId;
            }
          }

          if (loyaltyId) {
            const current = await prisma.$queryRawUnsafe<Array<{ id: string; points: number; tier: string; firstName: string | null }>>(
              `SELECT id, points, tier, "firstName" FROM "LoyaltyCustomer" WHERE id = $1`,
              loyaltyId
            );
            if (current[0]) {
              const newPts = current[0].points + ptsEarned;
              const newTier = newPts >= 5000 ? "platinum" : newPts >= 2000 ? "gold" : newPts >= 500 ? "silver" : "bronze";
              await prisma.$executeRawUnsafe(
                `UPDATE "LoyaltyCustomer"
                 SET points = $1, tier = $2, "visitCount" = "visitCount" + 1,
                     "totalSpent" = "totalSpent" + $3, "updatedAt" = NOW()
                 WHERE id = $4`,
                newPts, newTier, totalCents / 100, loyaltyId
              );
              await prisma.$executeRawUnsafe(
                `INSERT INTO "LoyaltyTransaction" (id, "customerId", type, points, description, "createdAt")
                 VALUES (gen_random_uuid()::text, $1, 'earn', $2, $3, NOW())`,
                loyaltyId, ptsEarned, `Table ${table.number} — ${(totalCents / 100).toFixed(2)} €`
              );
              earnedPoints = ptsEarned;
              loyaltyCustomer = { ...current[0], points: newPts, tier: newTier };
            }
          }
        }
      }

      // ── Email ticket ─────────────────────────────────────────────────────
      const { sendEmail, receiptWithLoyaltyHtml, canSendEmail } = await import("../email.js");
      const toEmail = sess?.customerEmail;
      if (toEmail && canSendEmail()) {
        const restaurant = await prisma.restaurant.findUnique({
          where: { id: me.restaurantId },
          select: { name: true, slug: true },
        });

        const TIER_LABELS: Record<string, string> = { bronze: "Bronze", silver: "Argent", gold: "Or", platinum: "Platine" };
        const TIER_ORDER = ["bronze", "silver", "gold", "platinum"];
        const nextTierKey = loyaltyCustomer
          ? TIER_ORDER[TIER_ORDER.indexOf(loyaltyCustomer.tier) + 1] ?? null
          : null;
        const ptsToNext = nextTierKey && loyaltyCustomer
          ? ({ silver: 500, gold: 2000, platinum: 5000 }[nextTierKey] ?? 0) - loyaltyCustomer.points
          : null;

        const items = orderRows.map((r) => ({
          name: r.itemName,
          qty: r.qty,
          unitEur: (r.unitCents / 100).toFixed(2),
        }));

        const cardUrl = (restaurant?.slug && loyaltyCustomer?.id)
          ? `https://matable.pro/${restaurant.slug}/carte/${loyaltyCustomer.id}`
          : "";

        const html = receiptWithLoyaltyHtml({
          restaurantName: restaurant?.name ?? "Restaurant",
          customerName: loyaltyCustomer?.firstName ?? sess?.customerName ?? null,
          totalEur: (totalCents / 100).toFixed(2),
          items,
          date: new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }),
          loyalty: loyaltyCustomer ? {
            points: loyaltyCustomer.points,
            earned: earnedPoints,
            tier: loyaltyCustomer.tier,
            nextTier: nextTierKey ? TIER_LABELS[nextTierKey] : null,
            ptsToNext,
            cardUrl,
          } : null,
        });

        sendEmail({
          to: toEmail,
          from: "tickets@matable.pro",
          subject: `🧾 Votre ticket — ${restaurant?.name ?? ""}${earnedPoints > 0 ? ` · +${earnedPoints} pts fidélité` : ""}`,
          html,
        }).catch((e: any) => console.error("[email] ticket failed:", e));
      }
    } catch (e) {
      console.error("[settle loyalty]", e);
      // Non-bloquant
    }

    return { ok: true };
  });

  app.post("/tables/:id/assign-server", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { serverId } = z.object({ serverId: z.string().nullable() }).parse(req.body);
    const table = await prisma.table.findFirst({
      where: { id, restaurantId: me.restaurantId },
      include: { sessions: { where: { active: true }, take: 1 } },
    });
    if (!table?.sessions[0]) return reply.code(400).send({ error: "no_active_session" });
    await prisma.tableSession.update({ where: { id: table.sessions[0].id }, data: { serverId: serverId || null } });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------
  app.get("/orders", async (req, reply) => {
    const me = await requirePro(req, reply);
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const orders = await prisma.order.findMany({
      where: { table: { restaurantId: me.restaurantId }, ...(q.status ? { status: q.status as any } : {}) },
      include: { table: true, server: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { orders };
  });

  app.post("/orders/:id/status", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { status } = z.object({ status: z.enum(["PENDING", "COOKING", "READY", "SERVED", "PAID", "CANCELLED"]) }).parse(req.body);
    const order = await prisma.order.findFirst({ where: { id, table: { restaurantId: me.restaurantId } } });
    if (!order) return reply.code(404).send({ error: "not_found" });
    const updated = await prisma.order.update({ where: { id }, data: { status } });
    emitToRestaurant(me.restaurantId, "order:updated", { id: updated.id, status: updated.status });
    emitToSession(updated.sessionId, "order:updated", { id: updated.id, status: updated.status });
    return { order: updated };
  });

  // PATCH /orders/:id/items — ajoute des articles à une commande existante (PENDING ou COOKING)
  app.patch("/orders/:id/items", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({
      add: z.array(z.object({
        menuItemId: z.string(),
        quantity:   z.number().int().min(1).max(50),
      })).min(1).max(50),
    }).parse(req.body);

    const order = await prisma.order.findFirst({
      where: { id, table: { restaurantId: me.restaurantId }, status: { in: ["PENDING", "COOKING"] } },
    });
    if (!order) return reply.code(404).send({ error: "not_found_or_not_editable" });

    // Resolve menu items
    const menuItemIds = body.add.map((i) => i.menuItemId);
    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: menuItemIds }, restaurantId: me.restaurantId, available: true },
      select: { id: true, name: true, priceCents: true },
    });
    const menuMap = new Map(menuItems.map((m) => [m.id, m]));

    // Read quantity discount tiers for these items (column managed via ensure_columns.sql)
    type DiscRow = { id: string; quantityDiscounts: any };
    const discRows = menuItemIds.length === 0 ? [] : await prisma.$queryRaw<DiscRow[]>`
      SELECT id, "quantityDiscounts" FROM "MenuItem" WHERE id = ANY(${menuItemIds}::text[])
    `;
    const tiersById = new Map(discRows.map((r) => [r.id, parseQuantityDiscounts(r.quantityDiscounts)]));

    // Merge into existing items array
    const existing: Array<{ menuItemId?: string; name: string; quantity: number; priceCents: number }> =
      Array.isArray(order.items) ? (order.items as any[]) : [];

    for (const incoming of body.add) {
      const meta = menuMap.get(incoming.menuItemId);
      if (!meta) continue;
      const idx = existing.findIndex((e) => e.menuItemId === incoming.menuItemId);
      if (idx >= 0) {
        existing[idx] = { ...existing[idx], quantity: existing[idx].quantity + incoming.quantity };
      } else {
        existing.push({ menuItemId: meta.id, name: meta.name, quantity: incoming.quantity, priceCents: meta.priceCents });
      }
    }

    // Re-apply quantity discounts on the merged lines (base price = menu item's current priceCents)
    for (const line of existing) {
      if (!line.menuItemId) continue;
      const meta = menuMap.get(line.menuItemId);
      const tiers = tiersById.get(line.menuItemId);
      if (meta && tiers && tiers.length > 0) {
        line.priceCents = effectiveUnitPriceCents(meta.priceCents, line.quantity, tiers);
      }
    }

    const newTotal = existing.reduce((s, i) => s + i.priceCents * i.quantity, 0);
    const updated = await prisma.order.update({
      where: { id },
      data: { items: existing as any, totalCents: newTotal },
      include: { table: true },
    });

    emitToRestaurant(me.restaurantId, "order:updated", { id: updated.id, status: updated.status });
    emitToSession(updated.sessionId, "order:updated", { id: updated.id, status: updated.status });
    return { order: updated };
  });

  // PATCH /orders/:id/modify — modifier quantites ou supprimer des articles (PENDING ou COOKING uniquement)
  app.patch("/orders/:id/modify", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({
      items: z.array(z.object({
        menuItemId: z.string(),
        quantity:   z.number().int().min(0).max(99), // 0 = supprimer l'article
      })).min(1).max(100),
    }).parse(req.body);

    const order = await prisma.order.findFirst({
      where: { id, table: { restaurantId: me.restaurantId }, status: { in: ["PENDING", "COOKING"] } },
    });
    if (!order) return reply.code(404).send({ error: "not_found_or_not_editable" });

    const existing: Array<{ menuItemId?: string; name: string; quantity: number; priceCents: number }> =
      Array.isArray(order.items) ? (order.items as any[]) : [];

    for (const mod of body.items) {
      const idx = existing.findIndex((e) => e.menuItemId === mod.menuItemId);
      if (idx < 0) continue; // article absent = ignorer
      if (mod.quantity === 0) {
        existing.splice(idx, 1); // supprimer l'article
      } else {
        existing[idx] = { ...existing[idx], quantity: mod.quantity };
      }
    }

    // Re-apply quantity discounts on lines whose qty changed (base price from current MenuItem)
    const remainingIds = existing.map((l) => l.menuItemId).filter((x): x is string => !!x);
    if (remainingIds.length > 0) {
      const menuItems = await prisma.menuItem.findMany({
        where: { id: { in: remainingIds }, restaurantId: me.restaurantId },
        select: { id: true, priceCents: true },
      });
      const baseById = new Map(menuItems.map((m) => [m.id, m.priceCents]));
      type DiscRow = { id: string; quantityDiscounts: any };
      const discRows = await prisma.$queryRaw<DiscRow[]>`
        SELECT id, "quantityDiscounts" FROM "MenuItem" WHERE id = ANY(${remainingIds}::text[])
      `;
      const tiersById = new Map(discRows.map((r) => [r.id, parseQuantityDiscounts(r.quantityDiscounts)]));
      for (const line of existing) {
        if (!line.menuItemId) continue;
        const base = baseById.get(line.menuItemId);
        const tiers = tiersById.get(line.menuItemId);
        if (base != null && tiers && tiers.length > 0) {
          line.priceCents = effectiveUnitPriceCents(base, line.quantity, tiers);
        }
      }
    }

    // Si la commande est vide apres modifs, annuler automatiquement
    if (existing.length === 0) {
      const updated = await prisma.order.update({
        where: { id },
        data: { status: "CANCELLED", items: [] as any, totalCents: 0 },
      });
      emitToRestaurant(me.restaurantId, "order:updated", { id: updated.id, status: "CANCELLED" });
      emitToSession(updated.sessionId, "order:updated", { id: updated.id, status: "CANCELLED" });
      return { order: updated, cancelled: true };
    }

    const newTotal = existing.reduce((s, i) => s + i.priceCents * i.quantity, 0);
    const updated = await prisma.order.update({
      where: { id },
      data: { items: existing as any, totalCents: newTotal },
      include: { table: true },
    });

    emitToRestaurant(me.restaurantId, "order:updated", { id: updated.id, status: updated.status });
    emitToSession(updated.sessionId, "order:updated", { id: updated.id, status: updated.status });
    return { order: updated };
  });

  // ---------------------------------------------------------------------------
  // Menu
  // ---------------------------------------------------------------------------
  app.get("/menu", async (req, reply) => {
    const me = await requirePro(req, reply);
    const items = await prisma.menuItem.findMany({
      where: { restaurantId: me.restaurantId },
      orderBy: [{ category: "asc" }, { position: "asc" }, { name: "asc" }],
      include: { modifierGroups: { include: { options: true }, orderBy: { position: "asc" } } },
    });
    // Attach extended columns from raw (added via ensure_columns.sql)
    const ids = items.map((i) => i.id);
    type ExtRow = { id: string; waitMinutes: number; suggestedPairings: any; upsellItems: any; quantityDiscounts: any; quantityTiers: any };
    let extRows: ExtRow[] = [];
    if (ids.length > 0) {
      extRows = await prisma.$queryRaw<ExtRow[]>`
        SELECT id,
               COALESCE("waitMinutes", 0)::int AS "waitMinutes",
               "suggestedPairings",
               "upsellItems",
               "quantityDiscounts",
               "quantityTiers"
        FROM "MenuItem" WHERE id = ANY(${ids}::text[])
      `;
    }
    const extMap = new Map(extRows.map((r) => [r.id, r]));
    return {
      items: items.map((i) => {
        const ext = extMap.get(i.id);
        return {
          ...i,
          waitMinutes: ext?.waitMinutes ?? 0,
          suggestedPairings: ext?.suggestedPairings ?? [],
          upsellItems: ext?.upsellItems ?? [],
          quantityDiscounts: parseQuantityDiscounts(ext?.quantityDiscounts),
          quantityTiers: parseQuantityTiers(ext?.quantityTiers),
        };
      })
    };
  });

  const menuInput = z.object({
    name: z.string().min(1),
    priceCents: z.number().int().min(0),
    description: z.string().optional(),
    category: z.string().optional(),
    available: z.boolean().optional(),
    imageUrl: z.string().url().optional().or(z.literal("")),
    allergens: z.array(z.enum(ALLERGENS)).optional(),
    diets: z.array(z.enum(DIETS)).optional(),
    stockEnabled: z.boolean().optional(),
    stockQty: z.number().int().min(0).optional().nullable(),
    lowStockThreshold: z.number().int().min(0).optional().nullable(),
    waitMinutes: z.number().int().min(0).max(180).optional(),
    position: z.number().int().optional(),
    suggestedPairings: z.array(z.string()).optional(),
    upsellItems: z.array(z.string()).optional(),
    quantityDiscounts: z.array(z.object({
      minQty: z.number().int().min(2).max(999),
      type: z.enum(["PERCENT", "FIXED_CENTS"]),
      value: z.number().int().min(0).max(100000),
    })).max(10).optional(),
    // Nouveaux paliers qty/prix total : [{ qty: 3, priceCents: 2200 }, ...]
    quantityTiers: z.array(z.object({
      qty: z.number().int().min(1).max(9999),
      priceCents: z.number().int().min(0).max(1_000_000),
    })).max(20).optional(),
  });

  app.post("/menu", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { waitMinutes, suggestedPairings, upsellItems, quantityDiscounts, quantityTiers, ...data } = menuInput.parse(req.body);
    const item = await prisma.menuItem.create({
      data: { ...data, imageUrl: data.imageUrl || null, restaurantId: me.restaurantId } as any,
    });

    // Extensions managed via ensure_columns.sql (not in Prisma schema)
    const updates: string[] = [];
    if (waitMinutes !== undefined) updates.push(`"waitMinutes" = ${Number(waitMinutes)}`);
    if (suggestedPairings !== undefined) updates.push(`"suggestedPairings" = '${JSON.stringify(suggestedPairings)}'::jsonb`);
    if (upsellItems !== undefined) updates.push(`"upsellItems" = '${JSON.stringify(upsellItems)}'::jsonb`);
    if (quantityDiscounts !== undefined) {
      const cleaned = parseQuantityDiscounts(quantityDiscounts);
      updates.push(`"quantityDiscounts" = '${JSON.stringify(cleaned).replace(/'/g, "''")}'::jsonb`);
    }
    if (quantityTiers !== undefined) {
      const cleaned = parseQuantityTiers(quantityTiers);
      updates.push(`"quantityTiers" = '${JSON.stringify(cleaned).replace(/'/g, "''")}'::jsonb`);
    }

    if (updates.length > 0) {
      await prisma.$executeRawUnsafe(`UPDATE "MenuItem" SET ${updates.join(", ")} WHERE id = $1`, item.id);
    }

    return { item: {
      ...item,
      waitMinutes: waitMinutes ?? 0,
      suggestedPairings: suggestedPairings ?? [],
      upsellItems: upsellItems ?? [],
      quantityDiscounts: parseQuantityDiscounts(quantityDiscounts ?? []),
      quantityTiers: parseQuantityTiers(quantityTiers ?? []),
    } };
  });

  app.patch("/menu/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { waitMinutes, suggestedPairings, upsellItems, quantityDiscounts, quantityTiers, ...data } = menuInput.partial().parse(req.body);
    if (data.imageUrl === "") (data as any).imageUrl = null;

    if (Object.keys(data).length > 0) {
      await prisma.menuItem.updateMany({ where: { id, restaurantId: me.restaurantId }, data: data as any });
    }

    // Extensions managed via ensure_columns.sql
    const updates: string[] = [];
    if (waitMinutes !== undefined) updates.push(`"waitMinutes" = ${Number(waitMinutes)}`);
    if (suggestedPairings !== undefined) updates.push(`"suggestedPairings" = '${JSON.stringify(suggestedPairings)}'::jsonb`);
    if (upsellItems !== undefined) updates.push(`"upsellItems" = '${JSON.stringify(upsellItems)}'::jsonb`);
    if (quantityDiscounts !== undefined) {
      const cleaned = parseQuantityDiscounts(quantityDiscounts);
      updates.push(`"quantityDiscounts" = '${JSON.stringify(cleaned).replace(/'/g, "''")}'::jsonb`);
    }
    if (quantityTiers !== undefined) {
      const cleaned = parseQuantityTiers(quantityTiers);
      updates.push(`"quantityTiers" = '${JSON.stringify(cleaned).replace(/'/g, "''")}'::jsonb`);
    }

    if (updates.length > 0) {
      // Must verify ownership again to be safe before raw update
      const exists = await prisma.menuItem.findFirst({ where: { id, restaurantId: me.restaurantId }});
      if (exists) {
        await prisma.$executeRawUnsafe(`UPDATE "MenuItem" SET ${updates.join(", ")} WHERE id = $1`, id);
      }
    }
    
    return { ok: true };
  });

  app.delete("/menu/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    await prisma.menuItem.deleteMany({ where: { id, restaurantId: me.restaurantId } });
    return { ok: true };
  });

  // PATCH /menu/:id/toggle-available — toggle rapide disponible/rupture pendant le service
  app.patch("/menu/:id/toggle-available", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const item = await prisma.menuItem.findFirst({
      where: { id, restaurantId: me.restaurantId },
      select: { id: true, available: true, name: true },
    });
    if (!item) return reply.code(404).send({ error: "not_found" });
    const updated = await prisma.menuItem.update({
      where: { id },
      data: { available: !item.available },
      select: { id: true, available: true, name: true },
    });
    // Emit so all connected dashboards see the change instantly
    emitToRestaurant(me.restaurantId, "menu:availability_changed", {
      itemId: id, name: updated.name, available: updated.available,
    });
    return { ok: true, available: updated.available };
  });

  app.post("/menu/:id/restock", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { delta, reason } = z.object({ delta: z.number().int(), reason: z.string().default("RESTOCK") }).parse(req.body);
    const item = await prisma.menuItem.findFirst({ where: { id, restaurantId: me.restaurantId } });
    if (!item) return reply.code(404).send({ error: "not_found" });
    const newQty = Math.max(0, (item.stockQty ?? 0) + delta);
    await prisma.$transaction([
      prisma.menuItem.update({ where: { id }, data: { stockQty: newQty } }),
      prisma.stockMovement.create({ data: { restaurantId: me.restaurantId, menuItemId: id, delta, reason } }),
    ]);
    return { ok: true, stockQty: newQty };
  });

  app.post("/menu/:id/modifiers", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const data = z.object({
      name: z.string().min(1),
      required: z.boolean().default(false),
      multiple: z.boolean().default(false),
      options: z.array(z.object({ name: z.string(), priceDeltaCents: z.number().int().default(0) })).min(1),
    }).parse(req.body);
    const item = await prisma.menuItem.findFirst({ where: { id, restaurantId: me.restaurantId } });
    if (!item) return reply.code(404).send({ error: "not_found" });
    const group = await prisma.modifierGroup.create({
      data: {
        menuItemId: id, name: data.name, required: data.required, multiple: data.multiple,
        options: { create: data.options.map((o, i) => ({ ...o, position: i })) },
      },
      include: { options: true },
    });
    return { group };
  });

  app.delete("/menu/modifier-group/:gid", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { gid } = req.params as { gid: string };
    const g = await prisma.modifierGroup.findUnique({ where: { id: gid }, include: { menuItem: true } });
    if (!g || g.menuItem.restaurantId !== me.restaurantId) return reply.code(404).send({ error: "not_found" });
    await prisma.modifierGroup.delete({ where: { id: gid } });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Servers (staff)
  // ---------------------------------------------------------------------------
  app.get("/servers", async (req, reply) => {
    const me = await requirePro(req, reply);
    const servers = await prisma.server.findMany({ where: { restaurantId: me.restaurantId }, orderBy: { name: "asc" } });
    const reviews = await prisma.serverReview.groupBy({
      by: ["serverId"], where: { restaurantId: me.restaurantId },
      _avg: { rating: true }, _count: { _all: true },
    });
    const byId = new Map(reviews.map((r) => [r.serverId, { avg: r._avg.rating, count: r._count._all }]));
    return {
      servers: servers.map((s) => ({ ...s, avgRating: byId.get(s.id)?.avg ?? null, reviewsCount: byId.get(s.id)?.count ?? 0 })),
    };
  });

  app.post("/servers", async (req, reply) => {
    const me = await requirePro(req, reply);
    const data = z.object({ name: z.string().min(1), photoUrl: z.string().url().optional() }).parse(req.body);
    const server = await prisma.server.create({ data: { ...data, restaurantId: me.restaurantId } });
    return { server };
  });

  app.patch("/servers/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const data = z.object({
      name: z.string().optional(),
      photoUrl: z.string().url().optional().or(z.literal("")),
      active: z.boolean().optional(),
      pin: z.string().min(4).max(6).regex(/^\d+$/).nullable().optional(),
    }).parse(req.body);
    if ((data as any).photoUrl === "") (data as any).photoUrl = null;
    await prisma.server.updateMany({ where: { id, restaurantId: me.restaurantId }, data: data as any });
    return { ok: true };
  });

  app.delete("/servers/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    await prisma.server.deleteMany({ where: { id, restaurantId: me.restaurantId } });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Upload server photo
  // ---------------------------------------------------------------------------
  app.post("/servers/:id/photo", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const server = await prisma.server.findFirst({ where: { id, restaurantId: me.restaurantId } });
    if (!server) return reply.code(404).send({ error: "not_found" });
    const part = await (req as any).file();
    if (!part) return reply.code(400).send({ error: "missing_file" });
    if (typeof part.mimetype !== "string" || !part.mimetype.startsWith("image/"))
      return reply.code(400).send({ error: "invalid_mime" });
    const buf: Buffer = await part.toBuffer();
    if (!buf.length) return reply.code(400).send({ error: "empty_file" });
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const photo = await prisma.photo.create({
      data: {
        restaurantId: me.restaurantId,
        kind: "STAFF",
        mimeType: part.mimetype,
        bytes: buf,
        size: buf.length,
        originalName: part.filename ?? "photo",
        sha256,
      },
    });
    const photoPath = `/api/photo/${photo.id}`;
    await prisma.server.update({ where: { id }, data: { photoUrl: photoPath } });
    return { ok: true, photoUrl: photoPath };
  });

  app.get("/servers/:id/schedules", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const server = await prisma.server.findFirst({ where: { id, restaurantId: me.restaurantId } });
    if (!server) return reply.code(404).send({ error: "not_found" });
    const schedules = await prisma.serverSchedule.findMany({
      where: { serverId: id }, orderBy: [{ dayOfWeek: "asc" }, { openMin: "asc" }],
    });
    return { schedules };
  });

  app.put("/servers/:id/schedules", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const server = await prisma.server.findFirst({ where: { id, restaurantId: me.restaurantId } });
    if (!server) return reply.code(404).send({ error: "not_found" });
    const body = z.array(z.object({
      dayOfWeek: z.number().int().min(0).max(6),
      openMin: z.number().int().min(0).max(1440),
      closeMin: z.number().int().min(0).max(1440),
    })).parse(req.body);
    await prisma.serverSchedule.deleteMany({ where: { serverId: id } });
    if (body.length > 0) await prisma.serverSchedule.createMany({ data: body.map((s) => ({ ...s, serverId: id })) });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Reviews
  // ---------------------------------------------------------------------------
  app.get("/reviews/dishes", async (req, reply) => {
    const me = await requirePro(req, reply);
    const reviews = await prisma.dishReview.findMany({
      where: { restaurantId: me.restaurantId },
      include: { menuItem: { select: { name: true } } },
      orderBy: { createdAt: "desc" }, take: 100,
    });
    return { reviews };
  });

  app.get("/reviews/servers", async (req, reply) => {
    const me = await requirePro(req, reply);
    const reviews = await prisma.serverReview.findMany({
      where: { restaurantId: me.restaurantId },
      include: { server: { select: { name: true } } },
      orderBy: { createdAt: "desc" }, take: 100,
    });
    return { reviews };
  });

  // ---------------------------------------------------------------------------
  // PATCH /api/pro/reviews/:kind/:id/resolve — Marquer un flag comme traité
  // kind ∈ "dish" | "server"
  // ---------------------------------------------------------------------------
  app.patch<{ Params: { kind: "dish" | "server"; id: string }; Body: { resolved?: boolean } }>(
    "/reviews/:kind/:id/resolve",
    async (req, reply) => {
      const me = await requirePro(req, reply);
      const { kind, id } = req.params;
      const resolved = req.body?.resolved !== false;

      if (kind === "dish") {
        const found = await prisma.dishReview.findFirst({ where: { id, restaurantId: me.restaurantId }, select: { id: true } });
        if (!found) return reply.code(404).send({ error: "not_found" });
        await prisma.dishReview.update({ where: { id }, data: { flagResolved: resolved } });
      } else if (kind === "server") {
        const found = await prisma.serverReview.findFirst({ where: { id, restaurantId: me.restaurantId }, select: { id: true } });
        if (!found) return reply.code(404).send({ error: "not_found" });
        await prisma.serverReview.update({ where: { id }, data: { flagResolved: resolved } });
      } else {
        return reply.code(400).send({ error: "invalid_kind" });
      }
      return { ok: true, resolved };
    }
  );

  // ---------------------------------------------------------------------------
  // GET /api/pro/reviews/insights — Plaintes récurrentes + alertes actives
  // Agrège les flagReasons sur DishReview + ServerReview pour l'admin
  // ---------------------------------------------------------------------------
  app.get("/reviews/insights", async (req, reply) => {
    const me = await requirePro(req, reply);

    const [dishFlags, serverFlags, dishLowComments, customerReviewsForKw] = await Promise.all([
      prisma.dishReview.findMany({
        where: { restaurantId: me.restaurantId, flagged: true },
        include: { menuItem: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.serverReview.findMany({
        where: { restaurantId: me.restaurantId, flagged: true },
        include: { server: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.dishReview.findMany({
        where: { restaurantId: me.restaurantId, comment: { not: null } },
        include: { menuItem: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.$queryRawUnsafe<any[]>(
        `SELECT id, "reviewText", ratings, "createdAt"
         FROM "CustomerReview"
         WHERE "restaurantId" = $1
         ORDER BY "createdAt" DESC
         LIMIT 200`,
        me.restaurantId
      ),
    ]);

    // Aggregate by reason
    const counts: Record<string, number> = {};
    const tally = (arr: any[]) => {
      for (const r of arr) {
        for (const reason of r.flagReasons ?? []) {
          counts[reason] = (counts[reason] ?? 0) + 1;
        }
      }
    };
    tally(dishFlags);
    tally(serverFlags);

    // Also scan CustomerReview text for keywords (raw ratings for low-rating fallback)
    const { detectFlagsWithRating } = await import("../reviewFlagger.js");
    const customerFlagged: any[] = [];
    for (const cr of customerReviewsForKw) {
      const rat = cr.ratings ?? {};
      const vals = [rat.food, rat.service, rat.atmosphere, rat.value].filter((v: any) => typeof v === "number");
      const avg = vals.length ? vals.reduce((a: number, b: number) => a + b, 0) / vals.length : null;
      const f = detectFlagsWithRating(avg, cr.reviewText);
      if (f.flagged) {
        customerFlagged.push({ id: cr.id, reasons: f.reasons, reviewText: cr.reviewText, createdAt: cr.createdAt });
        for (const reason of f.reasons) {
          counts[reason] = (counts[reason] ?? 0) + 1;
        }
      }
    }

    const reasonsRanked = Object.entries(counts)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count);

    return {
      counts: reasonsRanked,
      dishFlags: dishFlags.map(d => ({
        id: d.id,
        rating: d.rating,
        comment: d.comment,
        reasons: d.flagReasons,
        resolved: d.flagResolved,
        createdAt: d.createdAt,
        menuItemName: d.menuItem?.name ?? null,
      })),
      serverFlags: serverFlags.map(d => ({
        id: d.id,
        rating: d.rating,
        comment: d.comment,
        reasons: d.flagReasons,
        resolved: d.flagResolved,
        createdAt: d.createdAt,
        serverName: d.server?.name ?? null,
      })),
      customerFlags: customerFlagged,
      dishComments: dishLowComments.filter(d => (d.comment ?? "").length > 0).slice(0, 60).map(d => ({
        id: d.id,
        rating: d.rating,
        comment: d.comment,
        flagged: d.flagged,
        reasons: d.flagReasons,
        menuItemName: d.menuItem?.name ?? null,
        createdAt: d.createdAt,
      })),
    };
  });

  // ---------------------------------------------------------------------------
  // GET /api/pro/reviews/customers — Avis & Pourboires laissés via Campagne IA
  // ---------------------------------------------------------------------------
  app.get("/reviews/customers", async (req, reply) => {
    const me = await requirePro(req, reply);
    
    const [reviews, tips] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "CustomerReview" WHERE "restaurantId" = $1 ORDER BY "createdAt" DESC LIMIT 100`, me.restaurantId),
      prisma.$queryRawUnsafe<any[]>(`SELECT * FROM "ServerTip" WHERE "restaurantId" = $1 ORDER BY "createdAt" DESC LIMIT 100`, me.restaurantId)
    ]);

    return { reviews, tips };
  });

  // ---------------------------------------------------------------------------
  // GET /api/pro/reviews/stats — Aggregated stats + daily history for radar chart
  // ---------------------------------------------------------------------------
  app.get("/reviews/stats", async (req, reply) => {
    const me = await requirePro(req, reply);

    // All reviews with ratings
    const reviews = await prisma.$queryRawUnsafe<any[]>(
      `SELECT ratings, "chatHistory", "serverName", "createdAt"
       FROM "CustomerReview"
       WHERE "restaurantId" = $1
       ORDER BY "createdAt" DESC
       LIMIT 500`,
      me.restaurantId
    );

    // Global averages
    let totalFood = 0, totalService = 0, totalAtmo = 0, totalValue = 0, count = 0;
    // Daily buckets: { [YYYY-MM-DD]: { food, service, atmosphere, value, count, reviews[] } }
    const daily: Record<string, { food: number; service: number; atmosphere: number; value: number; count: number; best: string | null; worst: string | null }> = {};

    for (const r of reviews) {
      const rat = r.ratings;
      if (!rat || typeof rat !== "object") continue;
      const f = Number(rat.food) || 0;
      const s = Number(rat.service) || 0;
      const a = Number(rat.atmosphere) || 0;
      const v = Number(rat.value) || 0;
      if (!f && !s && !a && !v) continue;

      totalFood += f; totalService += s; totalAtmo += a; totalValue += v; count++;

      const day = new Date(r.createdAt).toISOString().slice(0, 10);
      if (!daily[day]) daily[day] = { food: 0, service: 0, atmosphere: 0, value: 0, count: 0, best: null, worst: null };
      daily[day].food += f;
      daily[day].service += s;
      daily[day].atmosphere += a;
      daily[day].value += v;
      daily[day].count++;
    }

    const avg = count > 0 ? {
      food: +(totalFood / count).toFixed(2),
      service: +(totalService / count).toFixed(2),
      atmosphere: +(totalAtmo / count).toFixed(2),
      value: +(totalValue / count).toFixed(2),
      global: +((totalFood + totalService + totalAtmo + totalValue) / (count * 4)).toFixed(2),
    } : { food: 0, service: 0, atmosphere: 0, value: 0, global: 0 };

    // Build daily history (last 30 days) with averages + best/worst extraction
    const history = Object.entries(daily)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 30)
      .map(([date, d]) => {
        const dayAvg = {
          food: +(d.food / d.count).toFixed(2),
          service: +(d.service / d.count).toFixed(2),
          atmosphere: +(d.atmosphere / d.count).toFixed(2),
          value: +(d.value / d.count).toFixed(2),
        };

        // Find best & worst criteria for that day
        const criteria = [
          { key: "Cuisine", val: dayAvg.food },
          { key: "Service", val: dayAvg.service },
          { key: "Ambiance", val: dayAvg.atmosphere },
          { key: "Qualité/Prix", val: dayAvg.value },
        ];
        criteria.sort((a, b) => b.val - a.val);

        return {
          date,
          count: d.count,
          avg: dayAvg,
          best: criteria[0].val > 0 ? `${criteria[0].key} (${criteria[0].val}/5)` : null,
          worst: criteria[criteria.length - 1].val > 0 ? `${criteria[criteria.length - 1].key} (${criteria[criteria.length - 1].val}/5)` : null,
        };
      });

    // Extract today's customer comments for synthesis
    const today = new Date().toISOString().slice(0, 10);
    const todayReviews = reviews.filter(r => new Date(r.createdAt).toISOString().slice(0, 10) === today);
    const todayComments: string[] = [];
    for (const r of todayReviews) {
      if (r.chatHistory && Array.isArray(r.chatHistory)) {
        for (const msg of r.chatHistory) {
          if (msg.role === "user" && msg.content) todayComments.push(msg.content);
        }
      }
    }

    return {
      totalReviews: count,
      avg,
      history,
      today: {
        date: today,
        count: todayReviews.length,
        comments: todayComments,
      },
    };
  });

  // ---------------------------------------------------------------------------
  // Service calls
  // ---------------------------------------------------------------------------
  app.get("/service-calls", async (req, reply) => {
    const me = await requirePro(req, reply);
    const calls = await prisma.serviceCall.findMany({
      where: { restaurantId: me.restaurantId, resolvedAt: null },
      include: { table: true }, orderBy: { createdAt: "asc" },
    });
    return { calls };
  });

  app.post("/service-calls/:id/resolve", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    await prisma.serviceCall.updateMany({ where: { id, restaurantId: me.restaurantId }, data: { resolvedAt: new Date() } });
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // Analytics & export Z
  // ---------------------------------------------------------------------------
  app.get("/analytics", async (req, reply) => {
    const me = await requirePro(req, reply);
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).parse(req.query);
    const since = new Date(Date.now() - q.days * 24 * 3600 * 1000);
    const paidOrders = await prisma.order.findMany({
      where: { table: { restaurantId: me.restaurantId }, status: "PAID", createdAt: { gte: since } },
      include: { server: true },
    });
    const revenueCents = paidOrders.reduce((s, o) => s + o.totalCents + o.tipCents, 0);
    const tipsCents = paidOrders.reduce((s, o) => s + o.tipCents, 0);
    const ordersCount = paidOrders.length;
    const avgTicketCents = ordersCount ? Math.round(revenueCents / ordersCount) : 0;
    const itemsSold = paidOrders.reduce((s, o) => s + (Array.isArray(o.items) ? (o.items as any[]).reduce((n, it) => n + (Number(it.quantity) || 0), 0) : 0), 0);
    const itemCounts = new Map<string, { name: string; qty: number; revenueCents: number }>();
    const categoryCounts = new Map<string, { name: string; qty: number; revenueCents: number }>();
    for (const o of paidOrders) {
      for (const it of (o.items as any[])) {
        const prev = itemCounts.get(it.name) ?? { name: it.name, qty: 0, revenueCents: 0 };
        prev.qty += it.quantity; prev.revenueCents += it.priceCents * it.quantity;
        itemCounts.set(it.name, prev);
        const cat = it.category ?? "Non catégorisé";
        const catPrev = categoryCounts.get(cat) ?? { name: cat, qty: 0, revenueCents: 0 };
        catPrev.qty += it.quantity; catPrev.revenueCents += it.priceCents * it.quantity;
        categoryCounts.set(cat, catPrev);
      }
    }
    const topItems = Array.from(itemCounts.values()).sort((a, b) => b.qty - a.qty).slice(0, 10);
    const byDay = new Map<string, number>();
    for (const o of paidOrders) {
      const key = o.createdAt.toISOString().slice(0, 10);
      byDay.set(key, (byDay.get(key) ?? 0) + o.totalCents + o.tipCents);
    }
    const revenueByDay = Array.from(byDay.entries()).sort().map(([date, cents]) => ({ date, cents }));
    const byServer = new Map<string, { name: string; revenueCents: number; orders: number }>();
    for (const o of paidOrders) {
      if (!o.server) continue;
      const prev = byServer.get(o.server.id) ?? { name: o.server.name, revenueCents: 0, orders: 0 };
      prev.revenueCents += o.totalCents + o.tipCents; prev.orders += 1;
      byServer.set(o.server.id, prev);
    }
    const reservations = await prisma.reservation.findMany({
      where: { restaurantId: me.restaurantId, startsAt: { gte: since } },
      select: { startsAt: true, partySize: true, status: true, table: { select: { zone: true } } },
    });
    const reservationStats = {
      count: reservations.length,
      covers: reservations.reduce((s, r) => s + r.partySize, 0),
      pending: reservations.filter(r => r.status === "PENDING").length,
      confirmed: reservations.filter(r => r.status === "CONFIRMED").length,
      seated: reservations.filter(r => r.status === "SEATED").length,
      honored: reservations.filter(r => r.status === "HONORED").length,
      noShows: reservations.filter(r => r.status === "NO_SHOW").length,
      cancelled: reservations.filter(r => r.status === "CANCELLED").length,
    };
    const reservationsByDay = new Map<string, { date: string; reservations: number; covers: number }>();
    const reservationsByZone = new Map<string, { zone: string; reservations: number; covers: number }>();
    for (const r of reservations) {
      const day = r.startsAt.toISOString().slice(0, 10);
      const dayPrev = reservationsByDay.get(day) ?? { date: day, reservations: 0, covers: 0 };
      dayPrev.reservations += 1; dayPrev.covers += r.partySize;
      reservationsByDay.set(day, dayPrev);
      const zone = r.table?.zone ?? "Sans zone";
      const zonePrev = reservationsByZone.get(zone) ?? { zone, reservations: 0, covers: 0 };
      zonePrev.reservations += 1; zonePrev.covers += r.partySize;
      reservationsByZone.set(zone, zonePrev);
    }

    const reviewAgg = await prisma.dishReview.aggregate({
      where: { restaurantId: me.restaurantId, createdAt: { gte: since } },
      _avg: { rating: true },
      _count: { id: true },
    });
    const loyalty = await prisma.$queryRawUnsafe<Array<{ customers: bigint; points: bigint; visits: bigint; offers: bigint; redemptions: bigint }>>(
      `SELECT
        (SELECT COUNT(*)::bigint FROM "LoyaltyCustomer" WHERE "restaurantId" = $1) AS customers,
        (SELECT COALESCE(SUM(points),0)::bigint FROM "LoyaltyCustomer" WHERE "restaurantId" = $1) AS points,
        (SELECT COALESCE(SUM("visitCount"),0)::bigint FROM "LoyaltyCustomer" WHERE "restaurantId" = $1) AS visits,
        (SELECT COUNT(*)::bigint FROM "LoyaltyOffer" WHERE "restaurantId" = $1 AND active = true) AS offers,
        (SELECT COUNT(*)::bigint FROM "LoyaltyTransaction" t JOIN "LoyaltyCustomer" c ON c.id = t."customerId" WHERE c."restaurantId" = $1 AND t.type = 'redeem') AS redemptions`,
      me.restaurantId
    ).catch(() => [{ customers: 0n, points: 0n, visits: 0n, offers: 0n, redemptions: 0n }]);

    // ── Heatmap affluence : ventes par jour de semaine × heure (fuseau Paris) ──
    const parisParts = (d: Date) => {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Paris", hour: "2-digit", hour12: false, weekday: "short",
      }).formatToParts(d);
      const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10) % 24;
      const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      const dow = wdMap[parts.find((p) => p.type === "weekday")?.value ?? "Mon"] ?? 1;
      return { hour, dow };
    };
    const heatCells = new Map<string, { dow: number; hour: number; orders: number; revenueCents: number }>();
    for (const o of paidOrders) {
      const { hour, dow } = parisParts(o.createdAt);
      const key = `${dow}-${hour}`;
      const cell = heatCells.get(key) ?? { dow, hour, orders: 0, revenueCents: 0 };
      cell.orders += 1; cell.revenueCents += o.totalCents + o.tipCents;
      heatCells.set(key, cell);
    }
    const salesHeatmap = Array.from(heatCells.values());

    // ── Poids morts : plats disponibles jamais vendus sur la période ──────────
    const menuForDead = await prisma.menuItem.findMany({
      where: { restaurantId: me.restaurantId },
      select: { name: true, priceCents: true, available: true, category: true },
    });
    const deadItems = menuForDead
      .filter((m) => m.available && !(itemCounts.get(m.name)?.qty))
      .map((m) => ({ name: m.name, priceCents: m.priceCents, category: m.category ?? "Non catégorisé" }))
      .slice(0, 30);

    // ── Période précédente (même durée) pour les tendances ↑↓ ─────────────────
    const prevSince = new Date(since.getTime() - q.days * 24 * 3600 * 1000);
    const [prevOrders, prevReservationsCount] = await Promise.all([
      prisma.order.findMany({
        where: { table: { restaurantId: me.restaurantId }, status: "PAID", createdAt: { gte: prevSince, lt: since } },
        select: { totalCents: true, tipCents: true },
      }),
      prisma.reservation.count({
        where: { restaurantId: me.restaurantId, startsAt: { gte: prevSince, lt: since } },
      }),
    ]);
    const prevRevenueCents = prevOrders.reduce((s, o) => s + o.totalCents + o.tipCents, 0);
    const prevOrdersCount = prevOrders.length;
    const previous = {
      revenueCents: prevRevenueCents,
      ordersCount: prevOrdersCount,
      avgTicketCents: prevOrdersCount ? Math.round(prevRevenueCents / prevOrdersCount) : 0,
      reservationsCount: prevReservationsCount,
    };

    return {
      sinceIso: since.toISOString(),
      revenueCents,
      tipsCents,
      ordersCount,
      avgTicketCents,
      itemsSold,
      topItems,
      salesHeatmap,
      deadItems,
      previous,
      topCategories: Array.from(categoryCounts.values()).sort((a, b) => b.revenueCents - a.revenueCents).slice(0, 10),
      revenueByDay,
      revenueByServer: Array.from(byServer.values()).sort((a, b) => b.revenueCents - a.revenueCents),
      reservations: reservationStats,
      reservationsByDay: Array.from(reservationsByDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
      reservationsByZone: Array.from(reservationsByZone.values()).sort((a, b) => b.reservations - a.reservations),
      reviews: { count: reviewAgg._count.id, avgRating: reviewAgg._avg.rating ?? 0 },
      loyalty: {
        customers: Number(loyalty[0]?.customers ?? 0n),
        points: Number(loyalty[0]?.points ?? 0n),
        visits: Number(loyalty[0]?.visits ?? 0n),
        activeOffers: Number(loyalty[0]?.offers ?? 0n),
        redemptions: Number(loyalty[0]?.redemptions ?? 0n),
      },
    };
  });

  app.get("/stats/overview", async (req, reply) => {
    const me = await requirePro(req, reply);
    const q = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }).parse(req.query ?? {});
    const since = new Date(Date.now() - q.days * 24 * 3600 * 1000);

    const [paidOrders, reservations, loyaltyStats, reviewAgg] = await Promise.all([
      prisma.order.findMany({
        where: { table: { restaurantId: me.restaurantId }, status: "PAID", createdAt: { gte: since } },
        select: { totalCents: true, tipCents: true, createdAt: true, items: true },
      }),
      prisma.reservation.findMany({
        where: { restaurantId: me.restaurantId, startsAt: { gte: since } },
        select: { startsAt: true, partySize: true, status: true },
      }),
      prisma.$queryRawUnsafe<Array<{ customers: bigint; points: bigint; visits: bigint; offers: bigint; redemptions: bigint }>>(
        `SELECT
          (SELECT COUNT(*)::bigint FROM "LoyaltyCustomer" WHERE "restaurantId" = $1) AS customers,
          (SELECT COALESCE(SUM(points),0)::bigint FROM "LoyaltyCustomer" WHERE "restaurantId" = $1) AS points,
          (SELECT COALESCE(SUM("visitCount"),0)::bigint FROM "LoyaltyCustomer" WHERE "restaurantId" = $1) AS visits,
          (SELECT COUNT(*)::bigint FROM "LoyaltyOffer" WHERE "restaurantId" = $1 AND active = true) AS offers,
          (SELECT COUNT(*)::bigint FROM "LoyaltyTransaction" t JOIN "LoyaltyCustomer" c ON c.id = t."customerId" WHERE c."restaurantId" = $1 AND t.type = 'redeem') AS redemptions`,
        me.restaurantId
      ).catch(() => [{ customers: 0n, points: 0n, visits: 0n, offers: 0n, redemptions: 0n }]),
      prisma.dishReview.aggregate({
        where: { restaurantId: me.restaurantId, createdAt: { gte: since } },
        _avg: { rating: true },
        _count: { id: true },
      }),
    ]);

    const revenueCents = paidOrders.reduce((s, o) => s + o.totalCents + o.tipCents, 0);
    const ordersCount = paidOrders.length;
    const avgTicketCents = ordersCount ? Math.round(revenueCents / ordersCount) : 0;
    const reservationsCount = reservations.length;
    const reservationCovers = reservations.reduce((s, r) => s + r.partySize, 0);
    const honoredReservations = reservations.filter(r => ["SEATED", "HONORED"].includes(r.status)).length;
    const noShows = reservations.filter(r => r.status === "NO_SHOW").length;
    const cancelled = reservations.filter(r => r.status === "CANCELLED").length;

    const byDay = new Map<string, { date: string; revenueCents: number; orders: number; reservations: number; covers: number }>();
    const ensure = (date: string) => {
      if (!byDay.has(date)) byDay.set(date, { date, revenueCents: 0, orders: 0, reservations: 0, covers: 0 });
      return byDay.get(date)!;
    };
    for (const o of paidOrders) {
      const d = o.createdAt.toISOString().slice(0, 10);
      const row = ensure(d);
      row.revenueCents += o.totalCents + o.tipCents;
      row.orders += 1;
    }
    for (const r of reservations) {
      const d = r.startsAt.toISOString().slice(0, 10);
      const row = ensure(d);
      row.reservations += 1;
      row.covers += r.partySize;
    }

    const loyalty = loyaltyStats[0] ?? { customers: 0n, points: 0n, visits: 0n, offers: 0n, redemptions: 0n };
    return {
      sinceIso: since.toISOString(),
      orders: { count: ordersCount, revenueCents, avgTicketCents },
      reservations: { count: reservationsCount, covers: reservationCovers, honored: honoredReservations, noShows, cancelled },
      loyalty: {
        customers: Number(loyalty.customers ?? 0n),
        points: Number(loyalty.points ?? 0n),
        visits: Number(loyalty.visits ?? 0n),
        activeOffers: Number(loyalty.offers ?? 0n),
        redemptions: Number(loyalty.redemptions ?? 0n),
      },
      reviews: { count: reviewAgg._count.id, avgRating: reviewAgg._avg.rating ?? 0 },
      daily: Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date)),
    };
  });

  app.get("/export/z", async (req, reply) => {
    const me = await requirePro(req, reply);
    const q = z.object({ date: z.string().optional() }).parse(req.query);
    const date = q.date ? new Date(q.date) : new Date();
    const start = new Date(date); start.setHours(0,0,0,0);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    const orders = await prisma.order.findMany({
      where: { table: { restaurantId: me.restaurantId }, status: "PAID", updatedAt: { gte: start, lt: end } },
      include: { session: true, table: true, server: true },
    });
    const totalTtc = orders.reduce((s, o) => s + o.totalCents + o.tipCents, 0);
    const csv = ["order_id,table,total_cents,tip_cents,payment_mode,server,paid_at",
      ...orders.map((o) => [o.id, o.table.number, o.totalCents, o.tipCents,
        o.session.billPaymentMode ?? "", o.server?.name ?? "", o.updatedAt.toISOString()].join(","))].join("\n");
    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="z-${start.toISOString().slice(0,10)}.csv"`);
    return reply.send(`# Z Export - ${start.toISOString().slice(0,10)}\n# Total: ${(totalTtc/100).toFixed(2)} EUR\n${csv}`);
  });

  // ---------------------------------------------------------------------------
  // Reservations
  // ---------------------------------------------------------------------------
  app.get("/reservations", async (req, reply) => {
    const me = await requirePro(req, reply);
    const q = z.object({ from: z.string().optional(), to: z.string().optional(), status: z.string().optional() }).parse(req.query);
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 24*3600*1000);
    const to = q.to ? new Date(q.to) : new Date(Date.now() + 30*24*3600*1000);
    const reservations = await prisma.reservation.findMany({
      where: { restaurantId: me.restaurantId, startsAt: { gte: from, lte: to }, ...(q.status ? { status: q.status as any } : {}) },
      include: { table: true }, orderBy: { startsAt: "asc" },
    });
    return { reservations };
  });

  // POST /reservations — création manuelle par le restaurateur
  app.post("/reservations", async (req, reply) => {
    const me = await requirePro(req, reply);
    const input = z.object({
      customerName:  z.string().min(1),
      customerEmail: z.string().email().optional().or(z.literal("")).default(""),
      customerPhone: z.string().optional().default(""),
      date:          z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      time:          z.string().regex(/^\d{2}:\d{2}$/),
      partySize:     z.number().int().min(1).max(50),
      notes:         z.string().optional(),
      tableId:       z.string().optional().nullable(),
    }).parse(req.body);

    const [h, m] = input.time.split(":").map(Number);
    const startsAt = new Date(`${input.date}T00:00:00`);
    startsAt.setHours(h, m, 0, 0);

    const reservation = await prisma.reservation.create({
      data: {
        restaurantId:  me.restaurantId,
        startsAt,
        partySize:     input.partySize,
        customerName:  input.customerName,
        customerEmail: input.customerEmail ?? "",
        customerPhone: input.customerPhone ?? "",
        status:        "CONFIRMED",
        tableId:       input.tableId ?? null,
      },
      include: { table: true },
    });

    emitToRestaurant(me.restaurantId, "reservation:new", {
      id:           reservation.id,
      customerName: reservation.customerName,
      partySize:    reservation.partySize,
      startsAt:     reservation.startsAt,
      source:       "manual",
    });

    return { reservation };
  });

  app.post("/reservations/:id/status", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { status, tableId } = z.object({
      status: z.enum(["CONFIRMED", "SEATED", "HONORED", "NO_SHOW", "CANCELLED"]).optional(),
      tableId: z.string().nullable().optional(),
    }).parse(req.body);
    const r = await prisma.reservation.findFirst({ where: { id, restaurantId: me.restaurantId } });
    if (!r) return reply.code(404).send({ error: "not_found" });
    const updated = await prisma.reservation.update({
      where: { id },
      data: {
        ...(status ? { status, ...(status === "CANCELLED" ? { cancelledAt: new Date() } : {}) } : {}),
        ...(tableId !== undefined ? { tableId } : {}),
      },
    });
    emitToRestaurant(me.restaurantId, "reservation:updated", { id: updated.id, status: updated.status });
    return { reservation: updated };
  });

  // ---------------------------------------------------------------------------
  // Photos multi (restaurant + plat)
  // ---------------------------------------------------------------------------

  // Liste les photos : optionnellement filtrées par menuItemId
  app.get("/photos", async (req, reply) => {
    const me = await requirePro(req, reply);
    const q = z.object({
      menuItemId: z.string().optional(),
      kind: z.enum(["RESTAURANT", "DISH", "STAFF"]).optional(),
    }).parse(req.query ?? {});
    const where: any = { restaurantId: me.restaurantId };
    if (q.menuItemId) where.menuItemId = q.menuItemId;
    if (q.kind) where.kind = q.kind;
    const photos = await prisma.photo.findMany({
      where,
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true, kind: true, menuItemId: true, mimeType: true, size: true, position: true, createdAt: true },
    });
    return { photos: photos.map((p) => ({ ...p, path: `/api/photo/${p.id}` })) };
  });

  // Upload multi-fichier (drag & drop / input multiple)
  // POST /api/pro/photos?menuItemId=xxx&kind=DISH (ou RESTAURANT par défaut)
  app.post("/photos", async (req, reply) => {
    const me = await requirePro(req, reply);
    const q = z.object({
      menuItemId: z.string().optional(),
      kind: z.enum(["RESTAURANT", "DISH"]).optional(),
    }).parse(req.query ?? {});
    const kind = q.kind ?? (q.menuItemId ? "DISH" : "RESTAURANT");

    // Si DISH : vérifier que le menuItem appartient bien au resto
    if (q.menuItemId) {
      const dish = await prisma.menuItem.findFirst({
        where: { id: q.menuItemId, restaurantId: me.restaurantId },
        select: { id: true },
      });
      if (!dish) return reply.code(404).send({ error: "menu_item_not_found" });
    }

    const parts = (req as any).parts() as AsyncIterable<any>;
    const created: any[] = [];
    let lastPosQ = await prisma.photo.findFirst({
      where: { restaurantId: me.restaurantId, kind, menuItemId: q.menuItemId ?? null },
      orderBy: { position: "desc" },
      select: { position: true },
    });
    const basePos = (lastPosQ?.position ?? -1) + 1;

    type FileEntry = { mimetype: string; buf: Buffer; filename: string };
    const entries: FileEntry[] = [];
    for await (const part of parts) {
      if (part.type !== "file") continue;
      if (typeof part.mimetype !== "string" || !part.mimetype.startsWith("image/")) continue;
      const buf: Buffer = await part.toBuffer();
      if (!buf.length || buf.length > 8 * 1024 * 1024) continue;
      entries.push({ mimetype: part.mimetype, buf, filename: part.filename });
    }

    if (entries.length === 0) return reply.code(400).send({ error: "no_valid_image_uploaded" });

    const photos = await Promise.all(
      entries.map((e, i) => {
        const sha256 = crypto.createHash("sha256").update(e.buf).digest("hex");
        return prisma.photo.create({
          data: {
            restaurantId: me.restaurantId,
            menuItemId: q.menuItemId ?? null,
            kind,
            mimeType: e.mimetype,
            bytes: e.buf,
            size: e.buf.length,
            originalName: e.filename,
            sha256,
            position: basePos + i,
          },
          select: { id: true, kind: true, menuItemId: true, mimeType: true, size: true, position: true },
        });
      })
    );

    return { photos: photos.map((p) => ({ ...p, path: `/api/photo/${p.id}` })) };
  });

  app.delete("/photos/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const photo = await prisma.photo.findFirst({ where: { id, restaurantId: me.restaurantId }, select: { id: true } });
    if (!photo) return reply.code(404).send({ error: "not_found" });
    await prisma.photo.delete({ where: { id } });
    return { ok: true };
  });

  app.patch("/photos/reorder", async (req, reply) => {
    const me = await requirePro(req, reply);
    const body = z.object({
      order: z.array(z.object({ id: z.string(), position: z.number().int().min(0) })).min(1),
    }).parse(req.body);
    await prisma.$transaction(
      body.order.map((o) =>
        prisma.photo.updateMany({
          where: { id: o.id, restaurantId: me.restaurantId },
          data: { position: o.position },
        })
      )
    );
    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // SAV — Support tickets (restaurant → admin)
  // ---------------------------------------------------------------------------
  app.post("/support", async (req, reply) => {
    const me = await requirePro(req, reply);
    const body = z.object({
      subject: z.string().min(1).max(200),
      message: z.string().min(1).max(5000),
      priority: z.enum(["LOW", "NORMAL", "URGENT"]).default("NORMAL"),
    }).parse(req.body);

    const id = crypto.randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "SupportTicket" (id, "restaurantId", "userId", subject, message, priority, status, "createdAt", "updatedAt")
      VALUES (${id}, ${me.restaurantId}, ${me.userId}, ${body.subject}, ${body.message}, ${body.priority}, 'OPEN', NOW(), NOW())
    `;
    return { ok: true, ticketId: id };
  });

  app.get("/support", async (req, reply) => {
    const me = await requirePro(req, reply);
    type Ticket = { id: string; subject: string; message: string; status: string; priority: string; adminReply: string | null; repliedAt: Date | null; createdAt: Date };
    const tickets = await prisma.$queryRaw<Ticket[]>`
      SELECT id, subject, message, status, priority, "adminReply", "repliedAt", "createdAt"
      FROM "SupportTicket"
      WHERE "restaurantId" = ${me.restaurantId}
      ORDER BY "createdAt" DESC
      LIMIT 50
    `;
    return { tickets };
  });

  // ---------------------------------------------------------------------------
  // Stock — gestion des matières premières / ingrédients bruts
  // ---------------------------------------------------------------------------
  const stockProductSchema = z.object({
    name: z.string().min(1).max(200),
    unit: z.string().min(1).max(30).default("kg"),
    category: z.string().min(1).max(100).default("Autre"),
    isFresh: z.boolean().default(false),
    currentQty: z.number().min(0).default(0),
    lowThreshold: z.number().min(0).default(0),
    weeklyEstimate: z.number().min(0).default(0),
    notes: z.string().max(1000).optional().nullable(),
    linkedDishes: z.array(z.string()).default([]),
  });

  type StockProductRow = {
    id: string;
    restaurantId: string;
    name: string;
    unit: string;
    category: string;
    isFresh: boolean;
    currentQty: number;
    lowThreshold: number;
    weeklyEstimate: number;
    notes: string | null;
    linkedDishes: string[];
    updatedAt: Date;
    createdAt: Date;
  };

  // GET /api/pro/stock
  app.get("/stock", async (req, reply) => {
    const me = await requirePro(req, reply);
    const products = await prisma.$queryRaw<StockProductRow[]>`
      SELECT id, "restaurantId", name, unit, category, "isFresh",
             "currentQty", "lowThreshold", "weeklyEstimate",
             notes, "linkedDishes", "updatedAt", "createdAt"
      FROM "StockProduct"
      WHERE "restaurantId" = ${me.restaurantId}
      ORDER BY category ASC, name ASC
    `;
    return { products };
  });

  // POST /api/pro/stock
  app.post("/stock", async (req, reply) => {
    const me = await requirePro(req, reply);
    const body = stockProductSchema.parse(req.body);
    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "StockProduct" (id, "restaurantId", name, unit, category, "isFresh",
         "currentQty", "lowThreshold", "weeklyEstimate", notes, "linkedDishes", "updatedAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW(), NOW())`,
      id, me.restaurantId, body.name, body.unit, body.category, body.isFresh,
      body.currentQty, body.lowThreshold, body.weeklyEstimate,
      body.notes ?? null, JSON.stringify(body.linkedDishes)
    );
    const rows = await prisma.$queryRaw<StockProductRow[]>`
      SELECT * FROM "StockProduct" WHERE id = ${id}
    `;
    return { product: rows[0] };
  });

  // PUT /api/pro/stock/:id
  app.put("/stock/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const body = stockProductSchema.parse(req.body);

    const existing = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "StockProduct" WHERE id = ${id} AND "restaurantId" = ${me.restaurantId}
    `;
    if (existing.length === 0) return reply.code(404).send({ error: "not_found" });

    await prisma.$executeRawUnsafe(
      `UPDATE "StockProduct"
       SET name = $1, unit = $2, category = $3, "isFresh" = $4,
           "currentQty" = $5, "lowThreshold" = $6, "weeklyEstimate" = $7,
           notes = $8, "linkedDishes" = $9::jsonb, "updatedAt" = NOW()
       WHERE id = $10 AND "restaurantId" = $11`,
      body.name, body.unit, body.category, body.isFresh,
      body.currentQty, body.lowThreshold, body.weeklyEstimate,
      body.notes ?? null, JSON.stringify(body.linkedDishes),
      id, me.restaurantId
    );
    const rows = await prisma.$queryRaw<StockProductRow[]>`
      SELECT * FROM "StockProduct" WHERE id = ${id}
    `;
    return { product: rows[0] };
  });

  // PATCH /api/pro/stock/:id/qty — mise à jour rapide de la quantité seule
  app.patch("/stock/:id/qty", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { qty } = z.object({ qty: z.number().min(0) }).parse(req.body);

    const existing = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "StockProduct" WHERE id = ${id} AND "restaurantId" = ${me.restaurantId}
    `;
    if (existing.length === 0) return reply.code(404).send({ error: "not_found" });

    await prisma.$executeRaw`
      UPDATE "StockProduct" SET "currentQty" = ${qty}, "updatedAt" = NOW()
      WHERE id = ${id} AND "restaurantId" = ${me.restaurantId}
    `;
    return { ok: true };
  });

  // DELETE /api/pro/stock/:id
  app.delete("/stock/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    await prisma.$executeRaw`
      DELETE FROM "StockProduct"
      WHERE id = ${id} AND "restaurantId" = ${me.restaurantId}
    `;
    return { ok: true };
  });

  // GET /api/pro/stock/daily-report — estimation de consommation du jour
  app.get("/stock/daily-report", async (req, reply) => {
    const me = await requirePro(req, reply);

    // Orders from today
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const orders = await prisma.order.findMany({
      where: {
        table: { restaurantId: me.restaurantId },
        status: { in: ["PENDING", "COOKING", "SERVED", "PAID"] },
        createdAt: { gte: today },
      },
      select: { items: true, totalCents: true, status: true },
    });

    // Aggregate dish quantities sold today
    const dishMap: Record<string, number> = {};
    let totalRevenueCents = 0;
    let totalOrders = 0;
    for (const o of orders) {
      totalOrders++;
      totalRevenueCents += o.totalCents;
      for (const item of (o.items as any[]) ?? []) {
        const name: string = item.name ?? "";
        dishMap[name] = (dishMap[name] ?? 0) + (item.quantity ?? 1);
      }
    }

    // Load all stock products and estimate consumption via linkedDishes
    type StockRow = { id: string; name: string; unit: string; category: string; currentQty: number; lowThreshold: number; weeklyEstimate: number; linkedDishes: string[] };
    const products = await prisma.$queryRaw<StockRow[]>`
      SELECT id, name, unit, category, "currentQty", "lowThreshold", "weeklyEstimate",
             COALESCE("linkedDishes", '[]'::jsonb) AS "linkedDishes"
      FROM "StockProduct"
      WHERE "restaurantId" = ${me.restaurantId}
    `;

    // Per product: estimated consumption = sum(qty_sold_for_linked_dish * weeklyEstimate/7)
    const consumptionReport = products.map((p) => {
      const linkedDishes: string[] = Array.isArray(p.linkedDishes) ? p.linkedDishes : [];
      let estimatedUsed = 0;
      const breakdown: Array<{ dish: string; sold: number; estimated: number }> = [];
      for (const dish of linkedDishes) {
        const sold = dishMap[dish] ?? 0;
        if (sold > 0) {
          // Estimate: if weekly = 7 portions/week → 1/day per dish sold
          const perDish = p.weeklyEstimate > 0 ? p.weeklyEstimate / 7 : 0;
          const used = Math.round((perDish * sold) * 100) / 100;
          estimatedUsed += used;
          breakdown.push({ dish, sold, estimated: used });
        }
      }
      const remainingEst = Math.max(0, p.currentQty - estimatedUsed);
      return {
        id: p.id, name: p.name, unit: p.unit, category: p.category,
        currentQty: p.currentQty, lowThreshold: p.lowThreshold,
        estimatedUsed: Math.round(estimatedUsed * 100) / 100,
        remainingEst: Math.round(remainingEst * 100) / 100,
        breakdown,
        isLow: p.lowThreshold > 0 && remainingEst <= p.lowThreshold,
        hasActivity: estimatedUsed > 0,
      };
    }).sort((a, b) => {
      if (a.isLow !== b.isLow) return a.isLow ? -1 : 1;
      if (a.hasActivity !== b.hasActivity) return a.hasActivity ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const topDishes = Object.entries(dishMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([name, qty]) => ({ name, qty }));

    return { totalOrders, totalRevenueCents, topDishes, consumptionReport };
  });

  // POST /api/pro/stock/import-ia — importe les produits suggérés par Nova Stock IA
  app.post("/stock/import-ia", async (req, reply) => {
    const me = await requirePro(req, reply);
    const body = z.object({
      products: z.array(z.object({
        name: z.string().min(1).max(200),
        unit: z.string().min(1).max(30).default("kg"),
        category: z.string().min(1).max(100).default("Autre"),
        isFresh: z.boolean().default(false),
        currentQty: z.number().min(0).default(0),
        lowThreshold: z.number().min(0).default(0),
        weeklyEstimate: z.number().min(0).default(0),
        notes: z.string().max(500).optional().nullable(),
        linkedDishes: z.array(z.string()).default([]),
      })).min(1).max(100),
    }).parse(req.body);

    const created: StockProductRow[] = [];
    for (const p of body.products) {
      const id = crypto.randomUUID();
      await prisma.$executeRawUnsafe(
        `INSERT INTO "StockProduct" (id, "restaurantId", name, unit, category, "isFresh",
           "currentQty", "lowThreshold", "weeklyEstimate", notes, "linkedDishes", "updatedAt", "createdAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, NOW(), NOW())`,
        id, me.restaurantId, p.name, p.unit, p.category, p.isFresh,
        p.currentQty, p.lowThreshold, p.weeklyEstimate,
        p.notes ?? null, JSON.stringify(p.linkedDishes)
      );
      created.push({ id, restaurantId: me.restaurantId, ...p, notes: p.notes ?? null, updatedAt: new Date(), createdAt: new Date() });
    }
    return { created: created.length };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Shopping History — historique des listes de courses
  // ─────────────────────────────────────────────────────────────────────────────

  // POST /api/pro/shopping-history — sauvegarder une liste de courses generee
  app.post("/shopping-history", async (req, reply) => {
    const me = await requirePro(req, reply);
    const body = z.object({
      title: z.string().min(1).max(300),
      itemCount: z.number().int().min(0),
      estimatedBudget: z.number().min(0),
      shoppingList: z.array(z.any()),
    }).parse(req.body);

    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "ShoppingHistory" (id, "restaurantId", title, "itemCount", "estimatedBudget", "shoppingList", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
      id, me.restaurantId, body.title, body.itemCount, body.estimatedBudget, JSON.stringify(body.shoppingList),
    );
    return { id };
  });

  // GET /api/pro/shopping-history — liste des courses passees
  app.get("/shopping-history", async (req, reply) => {
    const me = await requirePro(req, reply);
    type Row = { id: string; title: string; itemCount: number; estimatedBudget: number; realCost: number | null; completedAt: Date | null; notes: string | null; createdAt: Date };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT id, title, "itemCount", "estimatedBudget", "realCost", "completedAt", notes, "createdAt"
      FROM "ShoppingHistory"
      WHERE "restaurantId" = ${me.restaurantId}
      ORDER BY "createdAt" DESC
      LIMIT 50
    `;
    return { history: rows };
  });

  // GET /api/pro/shopping-history/:id — detail d'une liste de courses
  app.get("/shopping-history/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    type Row = { id: string; title: string; itemCount: number; estimatedBudget: number; realCost: number | null; shoppingList: any; completedAt: Date | null; notes: string | null; createdAt: Date };
    const rows = await prisma.$queryRaw<Row[]>`
      SELECT id, title, "itemCount", "estimatedBudget", "realCost", "shoppingList", "completedAt", notes, "createdAt"
      FROM "ShoppingHistory"
      WHERE id = ${id} AND "restaurantId" = ${me.restaurantId}
      LIMIT 1
    `;
    if (!rows.length) return reply.code(404).send({ error: "not_found" });
    return rows[0];
  });

  // PATCH /api/pro/shopping-history/:id/complete — marquer "courses faites" avec le prix reel
  // Met aussi à jour currentQty de chaque StockProduct correspondant (+toBuy acheté)
  app.patch("/shopping-history/:id/complete", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({
      realCost: z.number().min(0),
      notes: z.string().max(500).optional(),
    }).parse(req.body);

    // Récupérer la liste pour mettre à jour le stock
    type ShRow = { id: string; shoppingList: any; completedAt: Date | null };
    const rows = await prisma.$queryRaw<ShRow[]>`
      SELECT id, "shoppingList", "completedAt"
      FROM "ShoppingHistory"
      WHERE id = ${id} AND "restaurantId" = ${me.restaurantId}
      LIMIT 1
    `;
    if (!rows.length) return reply.code(404).send({ error: "not_found" });
    if (rows[0].completedAt) return reply.code(404).send({ error: "not_found_or_already_completed" });

    // Marquer comme complété
    await prisma.$executeRawUnsafe(
      `UPDATE "ShoppingHistory" SET "realCost" = $1, "completedAt" = NOW(), notes = $2
       WHERE id = $3 AND "restaurantId" = $4`,
      body.realCost, body.notes ?? null, id, me.restaurantId,
    );

    // Mettre à jour currentQty dans StockProduct pour chaque article acheté, ou le créer
    const shoppingList: Array<{ ingredient: string; toBuy: number; unit: string; category?: string }> = rows[0].shoppingList ?? [];
    let stockUpdated = 0;
    for (const item of shoppingList) {
      if (!item.ingredient || !item.toBuy || item.toBuy <= 0) continue;
      // Chercher par nom (case-insensitive)
      const updated = await prisma.$executeRawUnsafe(
        `UPDATE "StockProduct"
         SET "currentQty" = "currentQty" + $1, "updatedAt" = NOW()
         WHERE "restaurantId" = $2 AND LOWER(name) = LOWER($3)`,
        item.toBuy, me.restaurantId, item.ingredient,
      );
      if (Number(updated) > 0) {
        stockUpdated++;
      } else {
        // Si le produit n'existe pas, on le crée
        const newId = crypto.randomUUID();
        await prisma.$executeRawUnsafe(
          `INSERT INTO "StockProduct" (id, "restaurantId", name, unit, category, "currentQty", "updatedAt", "createdAt")
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
          newId, me.restaurantId, item.ingredient, item.unit || "unité(s)", item.category || "Autre", item.toBuy
        );
        stockUpdated++;
      }
    }

    return { ok: true, stockUpdated };
  });

  // PUT /api/pro/shopping-history/:id — modifier une liste manuellement (titre, articles, budget)
  app.put("/shopping-history/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const body = z.object({
      title: z.string().min(1).max(300).optional(),
      estimatedBudget: z.number().min(0).optional(),
      shoppingList: z.array(z.object({
        ingredient: z.string().min(1),
        category: z.string().default("Autre"),
        estimatedNeeded: z.number().min(0).default(0),
        alreadyHave: z.number().min(0).default(0),
        toBuy: z.number().min(0).default(0),
        unit: z.string().default("unité(s)"),
        priority: z.enum(["HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
        estimatedCost: z.number().optional(),
        reason: z.string().default(""),
      })).optional(),
    }).parse(req.body);

    const rows = await prisma.$queryRaw<{ id: string }[]>`
      SELECT id FROM "ShoppingHistory"
      WHERE id = ${id} AND "restaurantId" = ${me.restaurantId}
      LIMIT 1
    `;
    if (!rows.length) return reply.code(404).send({ error: "not_found" });

    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (body.title !== undefined) {
      updates.push(`title = $${idx++}`);
      params.push(body.title);
    }
    if (body.estimatedBudget !== undefined) {
      updates.push(`"estimatedBudget" = $${idx++}`);
      params.push(body.estimatedBudget);
    }
    if (body.shoppingList !== undefined) {
      updates.push(`"shoppingList" = $${idx++}::jsonb`);
      params.push(JSON.stringify(body.shoppingList));
      updates.push(`"itemCount" = $${idx++}`);
      params.push(body.shoppingList.length);
    }

    if (updates.length > 0) {
      params.push(id, me.restaurantId);
      await prisma.$executeRawUnsafe(
        `UPDATE "ShoppingHistory" SET ${updates.join(", ")}
         WHERE id = $${idx++} AND "restaurantId" = $${idx}`,
        ...params,
      );
    }

    const updated = await prisma.$queryRaw<any[]>`
      SELECT id, title, "itemCount", "estimatedBudget", "realCost", "shoppingList", "completedAt", notes, "createdAt"
      FROM "ShoppingHistory"
      WHERE id = ${id}
    `;
    return updated[0];
  });

  // DELETE /api/pro/shopping-history/:id — supprimer une liste
  app.delete("/shopping-history/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    await prisma.$executeRaw`
      DELETE FROM "ShoppingHistory"
      WHERE id = ${id} AND "restaurantId" = ${me.restaurantId}
    `;
    return { ok: true };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // NovaContab IA — Aide à la déclaration URSSAF / TVA
  // ─────────────────────────────────────────────────────────────────────────────

  // GET /api/pro/novacontab/report — Données brutes URSSAF (disponible pour tous)
  app.get("/novacontab/report", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { year, month, quarter } = z.object({
      year: z.string().regex(/^\d{4}$/),
      month: z.string().regex(/^(0?[1-9]|1[0-2])$/).optional(),
      quarter: z.string().regex(/^[1-4]$/).optional(),
    }).parse(req.query);

    const y = parseInt(year, 10);
    let start: Date, end: Date;

    if (month) {
      const m = parseInt(month, 10);
      start = new Date(y, m - 1, 1);
      end = new Date(y, m, 1);
    } else if (quarter) {
      const q = parseInt(quarter, 10);
      start = new Date(y, (q - 1) * 3, 1);
      end = new Date(y, q * 3, 1);
    } else {
      return reply.code(400).send({ error: "missing_period" });
    }

    const orders = await prisma.order.findMany({
      where: {
        table: { restaurantId: me.restaurantId },
        createdAt: { gte: start, lt: end },
        status: { in: ["PAID", "SERVED", "COOKING", "PENDING"] } // usually PAID, but keeping it broad for now if status tracking isn't strict
      },
      select: { totalCents: true, items: true }
    });

    let totalCents = 0;
    let onSiteCents = 0;
    let takeAwayCents = 0;

    for (const o of orders) {
      totalCents += o.totalCents;
      // Pour l'instant, on met tout dans "sur place" par défaut.
      // Si une notion "à emporter" existe dans les items/orders, il faudra la parser ici.
      onSiteCents += o.totalCents;
    }

    return {
      period: { start, end },
      revenue: {
        totalCents,
        onSiteCents,
        takeAwayCents,
      },
      ordersCount: orders.length,
    };
  });

  // ============================================================================
  // LOYALTY — Programme de fidélisation
  // ============================================================================

  // Tier calculé selon les points
  function computeTier(points: number): string {
    if (points >= 5000) return "platinum";
    if (points >= 2000) return "gold";
    if (points >= 500)  return "silver";
    return "bronze";
  }

  function normalizeNullableDate(input?: string | null): string | null {
    if (!input) return null;
    const d = new Date(input);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  function normalizeText(input?: string | null): string | null {
    const v = typeof input === "string" ? input.trim() : "";
    return v.length > 0 ? v : null;
  }

  function normalizeEmail(input?: string | null): string | null {
    const v = normalizeText(input)?.toLowerCase() ?? null;
    return v;
  }

  async function ensureLoyaltySchema() {
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LoyaltyCustomer" (
      "id" TEXT NOT NULL,
      "restaurantId" TEXT NOT NULL,
      "firstName" TEXT,
      "lastName" TEXT,
      "email" TEXT,
      "phone" TEXT,
      "points" INTEGER NOT NULL DEFAULT 0,
      "tier" TEXT NOT NULL DEFAULT 'bronze',
      "totalSpent" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "visitCount" INTEGER NOT NULL DEFAULT 0,
      "birthDate" TIMESTAMP(3),
      "notes" TEXT,
      "source" TEXT NOT NULL DEFAULT 'manual',
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LoyaltyCustomer_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "LoyaltyCustomer_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE
    )`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "LoyaltyCustomer"
      ADD COLUMN IF NOT EXISTS "firstName" TEXT,
      ADD COLUMN IF NOT EXISTS "lastName" TEXT,
      ADD COLUMN IF NOT EXISTS "email" TEXT,
      ADD COLUMN IF NOT EXISTS "phone" TEXT,
      ADD COLUMN IF NOT EXISTS "points" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "tier" TEXT NOT NULL DEFAULT 'bronze',
      ADD COLUMN IF NOT EXISTS "totalSpent" DOUBLE PRECISION NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "visitCount" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "birthDate" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "notes" TEXT,
      ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'manual',
      ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "LoyaltyCustomer_restaurantId_email_key" ON "LoyaltyCustomer"("restaurantId","email") WHERE "email" IS NOT NULL`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LoyaltyCustomer_restaurantId_idx" ON "LoyaltyCustomer"("restaurantId")`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LoyaltyOffer" (
      "id" TEXT NOT NULL,
      "restaurantId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "description" TEXT,
      "type" TEXT NOT NULL DEFAULT 'discount_pct',
      "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
      "pointsCost" INTEGER NOT NULL DEFAULT 100,
      "minTier" TEXT,
      "active" BOOLEAN NOT NULL DEFAULT true,
      "expiresAt" TIMESTAMP(3),
      "usageLimit" INTEGER,
      "usageCount" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LoyaltyOffer_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "LoyaltyOffer_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE
    )`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "LoyaltyOffer"
      ADD COLUMN IF NOT EXISTS "description" TEXT,
      ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'discount_pct',
      ADD COLUMN IF NOT EXISTS "value" DOUBLE PRECISION NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "pointsCost" INTEGER NOT NULL DEFAULT 100,
      ADD COLUMN IF NOT EXISTS "minTier" TEXT,
      ADD COLUMN IF NOT EXISTS "active" BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3),
      ADD COLUMN IF NOT EXISTS "usageLimit" INTEGER,
      ADD COLUMN IF NOT EXISTS "usageCount" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LoyaltyOffer_restaurantId_idx" ON "LoyaltyOffer"("restaurantId")`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LoyaltyTransaction" (
      "id" TEXT NOT NULL,
      "customerId" TEXT NOT NULL,
      "offerId" TEXT,
      "type" TEXT NOT NULL,
      "points" INTEGER NOT NULL,
      "description" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LoyaltyTransaction_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "LoyaltyTransaction_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "LoyaltyCustomer"("id") ON DELETE CASCADE
    )`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "LoyaltyTransaction"
      ADD COLUMN IF NOT EXISTS "offerId" TEXT,
      ADD COLUMN IF NOT EXISTS "description" TEXT,
      ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "LoyaltyTransaction_customerId_idx" ON "LoyaltyTransaction"("customerId")`);
    await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "LoyaltyConfig" (
      "id" TEXT NOT NULL,
      "restaurantId" TEXT NOT NULL,
      "enabled" BOOLEAN NOT NULL DEFAULT false,
      "ptsPerEuro" INTEGER NOT NULL DEFAULT 10,
      "minSpendCents" INTEGER NOT NULL DEFAULT 0,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LoyaltyConfig_pkey" PRIMARY KEY ("id"),
      CONSTRAINT "LoyaltyConfig_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant"("id") ON DELETE CASCADE,
      CONSTRAINT "LoyaltyConfig_restaurantId_key" UNIQUE ("restaurantId")
    )`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "LoyaltyConfig"
      ADD COLUMN IF NOT EXISTS "enabled" BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "ptsPerEuro" INTEGER NOT NULL DEFAULT 10,
      ADD COLUMN IF NOT EXISTS "minSpendCents" INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`);
  }

  // Helper : upsert client par email ou phone dans la même transaction
  async function upsertLoyaltyCustomer(
    restaurantId: string,
    data: {
      firstName?: string; lastName?: string; email?: string; phone?: string;
      points?: number; totalSpent?: number; visitCount?: number;
      birthDate?: string; notes?: string; source?: string;
    }
  ) {
    const id = crypto.randomUUID();
    const points = data.points ?? 0;
    const tier = computeTier(points);

    // Try find by email first, then phone
    let existing: { id: string; points: number } | null = null;
    if (data.email) {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; points: number }>>(
        `SELECT id, points FROM "LoyaltyCustomer" WHERE "restaurantId" = $1 AND email = $2 LIMIT 1`,
        restaurantId, data.email
      );
      existing = rows[0] ?? null;
    }
    if (!existing && data.phone) {
      const rows = await prisma.$queryRawUnsafe<Array<{ id: string; points: number }>>(
        `SELECT id, points FROM "LoyaltyCustomer" WHERE "restaurantId" = $1 AND phone = $2 LIMIT 1`,
        restaurantId, data.phone
      );
      existing = rows[0] ?? null;
    }

    if (existing) {
      // Update — merge points
      const newPoints = existing.points + points;
      const newTier = computeTier(newPoints);
      await prisma.$executeRawUnsafe(
        `UPDATE "LoyaltyCustomer" SET
          "firstName" = COALESCE($1, "firstName"),
          "lastName"  = COALESCE($2, "lastName"),
          "phone"     = COALESCE($3, "phone"),
          "points"    = $4,
          "tier"      = $5,
          "totalSpent"  = "totalSpent" + $6,
          "visitCount"  = "visitCount" + $7,
          "birthDate"   = COALESCE($8::timestamp, "birthDate"),
          "notes"       = COALESCE($9, "notes"),
          "updatedAt"   = CURRENT_TIMESTAMP
        WHERE id = $10`,
        data.firstName ?? null, data.lastName ?? null, data.phone ?? null,
        newPoints, newTier,
        data.totalSpent ?? 0, data.visitCount ?? 0,
        normalizeNullableDate(data.birthDate),
        data.notes ?? null,
        existing.id
      );
      return existing.id;
    } else {
      await prisma.$executeRawUnsafe(
        `INSERT INTO "LoyaltyCustomer"
          (id, "restaurantId", "firstName", "lastName", email, phone, points, tier,
           "totalSpent", "visitCount", "birthDate", notes, source, "createdAt", "updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
        id, restaurantId,
        data.firstName ?? null, data.lastName ?? null,
        normalizeEmail(data.email), normalizeText(data.phone),
        points, tier,
        data.totalSpent ?? 0, data.visitCount ?? 0,
        normalizeNullableDate(data.birthDate),
        data.notes ?? null,
        data.source ?? "manual"
      );
      return id;
    }
  }

  // GET /loyalty/customers — liste paginée avec filtres
  app.get("/loyalty/customers", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const { search = "", tier = "", page = "1", limit = "50" } = req.query as Record<string, string>;
    const offset = (Math.max(1, parseInt(page)) - 1) * Math.min(100, parseInt(limit));
    const lim    = Math.min(100, parseInt(limit));

    const tierFilter = tier && ["bronze","silver","gold","platinum"].includes(tier)
      ? `AND tier = '${tier}'` : "";
    const searchFilter = search
      ? `AND (LOWER("firstName") LIKE $2 OR LOWER("lastName") LIKE $2 OR LOWER(email) LIKE $2 OR phone LIKE $2)` : "";
    const searchVal = `%${search.toLowerCase()}%`;

    const params: unknown[] = search
      ? [restaurantId, searchVal]
      : [restaurantId];

    const customers = await prisma.$queryRawUnsafe<Array<{
      id: string; firstName: string|null; lastName: string|null;
      email: string|null; phone: string|null; points: number;
      tier: string; totalSpent: number; visitCount: number;
      birthDate: string|null; notes: string|null; source: string; createdAt: string;
    }>>(
      `SELECT id, "firstName", "lastName", email, phone, points, tier,
              "totalSpent", "visitCount", "birthDate", notes, source, "createdAt"
       FROM "LoyaltyCustomer"
       WHERE "restaurantId" = $1 ${searchFilter} ${tierFilter}
       ORDER BY points DESC, "createdAt" DESC
       LIMIT ${lim} OFFSET ${offset}`,
      ...params
    );

    const countRows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count FROM "LoyaltyCustomer"
       WHERE "restaurantId" = $1 ${searchFilter} ${tierFilter}`,
      ...params
    );
    const total = Number(countRows[0]?.count ?? 0);

    return { customers, total, page: parseInt(page), limit: lim };
  });

  // POST /loyalty/ensure-schema — fallback self-healing for admins/pro dashboard
  app.post("/loyalty/ensure-schema", async (req, reply) => {
    await requirePro(req, reply);
    await ensureLoyaltySchema();
    return { ok: true };
  });

  // POST /loyalty/customers — créer un client
  app.post("/loyalty/customers", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const data = z.object({
      firstName: z.string().optional(),
      lastName:  z.string().optional(),
      email:     z.string().email().optional(),
      phone:     z.string().optional(),
      points:    z.number().int().min(0).default(0),
      totalSpent: z.number().min(0).default(0),
      visitCount: z.number().int().min(0).default(0),
      birthDate:  z.string().optional(),
      notes:      z.string().optional(),
    }).parse(req.body);

    if (!normalizeEmail(data.email) && !normalizeText(data.phone) && !normalizeText(data.firstName) && !normalizeText(data.lastName)) {
      return reply.code(400).send({ error: "missing_customer_identity" });
    }
    const id = await upsertLoyaltyCustomer(restaurantId, {
      ...data,
      firstName: normalizeText(data.firstName) ?? undefined,
      lastName: normalizeText(data.lastName) ?? undefined,
      email: normalizeEmail(data.email) ?? undefined,
      phone: normalizeText(data.phone) ?? undefined,
      birthDate: normalizeNullableDate(data.birthDate) ?? undefined,
      source: "manual",
    });
    return reply.code(201).send({ id });
  });

  // POST /loyalty/customers/import — import CSV/JSON bulk
  app.post("/loyalty/customers/import", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const body = z.object({
      customers: z.array(z.object({
        firstName: z.string().optional(),
        lastName:  z.string().optional(),
        email:     z.string().optional(),
        phone:     z.string().optional(),
        points:    z.number().int().min(0).optional().default(0),
        totalSpent: z.number().min(0).optional().default(0),
        visitCount: z.number().int().min(0).optional().default(0),
        birthDate:  z.string().optional(),
        notes:      z.string().optional(),
      })).max(5000),
    }).parse(req.body);

    let imported = 0, skipped = 0;
    for (const c of body.customers) {
      if (!c.email && !c.phone && !c.firstName && !c.lastName) { skipped++; continue; }
      try {
        await upsertLoyaltyCustomer(restaurantId, {
          ...c,
          firstName: normalizeText(c.firstName) ?? undefined,
          lastName: normalizeText(c.lastName) ?? undefined,
          email: normalizeEmail(c.email) ?? undefined,
          phone: normalizeText(c.phone) ?? undefined,
          birthDate: normalizeNullableDate(c.birthDate) ?? undefined,
          source: "import",
        });
        imported++;
      } catch { skipped++; }
    }
    return { imported, skipped, total: body.customers.length };
  });

  // GET /loyalty/customers/:id — détail + transactions
  app.get("/loyalty/customers/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const { id } = req.params as { id: string };

    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string; firstName: string|null; lastName: string|null;
      email: string|null; phone: string|null; points: number;
      tier: string; totalSpent: number; visitCount: number;
      birthDate: string|null; notes: string|null; source: string; createdAt: string;
    }>>(
      `SELECT * FROM "LoyaltyCustomer" WHERE id = $1 AND "restaurantId" = $2 LIMIT 1`,
      id, restaurantId
    );
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });

    const txns = await prisma.$queryRawUnsafe<Array<{
      id: string; type: string; points: number; description: string|null; createdAt: string; offerId: string|null;
    }>>(
      `SELECT id, type, points, description, "createdAt", "offerId"
       FROM "LoyaltyTransaction" WHERE "customerId" = $1
       ORDER BY "createdAt" DESC LIMIT 50`,
      id
    );

    return { customer: rows[0], transactions: txns };
  });

  // PATCH /loyalty/customers/:id — modifier
  app.patch("/loyalty/customers/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const { id } = req.params as { id: string };
    const data = z.object({
      firstName: z.string().optional(),
      lastName:  z.string().optional(),
      email:     z.string().email().optional().nullable(),
      phone:     z.string().optional().nullable(),
      notes:     z.string().optional().nullable(),
      birthDate: z.string().optional().nullable(),
    }).parse(req.body);

    await prisma.$executeRawUnsafe(
      `UPDATE "LoyaltyCustomer" SET
        "firstName" = COALESCE($1, "firstName"),
        "lastName"  = COALESCE($2, "lastName"),
        email       = COALESCE($3, email),
        phone       = COALESCE($4, phone),
        notes       = $5,
        "birthDate" = $6::timestamp,
        "updatedAt" = CURRENT_TIMESTAMP
       WHERE id = $7 AND "restaurantId" = $8`,
      normalizeText(data.firstName), normalizeText(data.lastName),
      normalizeEmail(data.email), normalizeText(data.phone),
      data.notes ?? null,
      normalizeNullableDate(data.birthDate),
      id, restaurantId
    );
    return { ok: true };
  });

  // POST /loyalty/customers/:id/points — ajouter/retirer des points
  app.post("/loyalty/customers/:id/points", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const { id } = req.params as { id: string };
    const { delta, description } = z.object({
      delta:       z.number().int(),
      description: z.string().optional(),
    }).parse(req.body);

    const rows = await prisma.$queryRawUnsafe<Array<{ points: number }>>(
      `SELECT points FROM "LoyaltyCustomer" WHERE id = $1 AND "restaurantId" = $2 LIMIT 1`,
      id, restaurantId
    );
    if (!rows[0]) return reply.code(404).send({ error: "not_found" });

    const newPoints = Math.max(0, rows[0].points + delta);
    const newTier   = computeTier(newPoints);

    await prisma.$executeRawUnsafe(
      `UPDATE "LoyaltyCustomer" SET points = $1, tier = $2, "updatedAt" = CURRENT_TIMESTAMP
       WHERE id = $3 AND "restaurantId" = $4`,
      newPoints, newTier, id, restaurantId
    );

    const txnId = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LoyaltyTransaction" (id, "customerId", type, points, description, "createdAt")
       VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
      txnId, id,
      delta >= 0 ? "earn" : "adjust",
      delta,
      description ?? (delta >= 0 ? `+${delta} points ajoutés manuellement` : `${delta} points ajustés`)
    );

    return { ok: true, newPoints, newTier };
  });

  // DELETE /loyalty/customers/:id
  app.delete("/loyalty/customers/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const { id } = req.params as { id: string };
    await prisma.$executeRawUnsafe(
      `DELETE FROM "LoyaltyCustomer" WHERE id = $1 AND "restaurantId" = $2`,
      id, restaurantId
    );
    return { ok: true };
  });

  // ── Offres ──────────────────────────────────────────────────────────────────

  // GET /loyalty/offers
  app.get("/loyalty/offers", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const offers = await prisma.$queryRawUnsafe<Array<{
      id: string; name: string; description: string|null; type: string;
      value: number; pointsCost: number; minTier: string|null;
      active: boolean; expiresAt: string|null; usageLimit: number|null;
      usageCount: number; createdAt: string;
    }>>(
      `SELECT id, name, description, type, value, "pointsCost", "minTier",
              active, "expiresAt", "usageLimit", "usageCount", "createdAt"
       FROM "LoyaltyOffer" WHERE "restaurantId" = $1 ORDER BY "createdAt" DESC`,
      restaurantId
    );
    return { offers };
  });

  // POST /loyalty/offers
  app.post("/loyalty/offers", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const data = z.object({
      name:        z.string().trim().min(1).max(120),
      description: z.string().max(500).optional().nullable(),
      type:        z.enum(["discount_pct","discount_fixed","free_item","double_points","birthday"]),
      value:       z.coerce.number().min(0).default(0),
      pointsCost:  z.coerce.number().int().min(0),
      minTier:     z.enum(["bronze","silver","gold","platinum"]).optional(),
      expiresAt:   z.string().optional(),
      usageLimit:  z.coerce.number().int().positive().optional(),
    }).parse(req.body);

    if (data.type === "discount_pct" && data.value > 100) {
      return reply.code(400).send({ error: "discount_pct_too_high" });
    }

    const id = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LoyaltyOffer"
         (id, "restaurantId", name, description, type, value, "pointsCost", "minTier",
          active, "expiresAt", "usageLimit", "usageCount", "createdAt")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9::timestamp,$10,0,CURRENT_TIMESTAMP)`,
      id, restaurantId,
      data.name, normalizeText(data.description),
      data.type, data.value, data.pointsCost,
      data.minTier ?? null,
      normalizeNullableDate(data.expiresAt),
      data.usageLimit ?? null
    );
    return reply.code(201).send({ id });
  });

  // PATCH /loyalty/offers/:id
  app.patch("/loyalty/offers/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const { id } = req.params as { id: string };
    const data = z.object({
      name:        z.string().trim().min(1).max(120).optional(),
      description: z.string().optional().nullable(),
      type:        z.enum(["discount_pct","discount_fixed","free_item","double_points","birthday"]).optional(),
      value:       z.coerce.number().min(0).optional(),
      pointsCost:  z.coerce.number().int().min(0).optional(),
      minTier:     z.enum(["bronze","silver","gold","platinum"]).optional().nullable(),
      active:      z.boolean().optional(),
      expiresAt:   z.string().optional().nullable(),
      usageLimit:  z.coerce.number().int().positive().optional().nullable(),
    }).parse(req.body);

    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (data.name        !== undefined) { sets.push(`name = $${i++}`);          vals.push(data.name); }
    if (data.description !== undefined) { sets.push(`description = $${i++}`);   vals.push(data.description); }
    if (data.type        !== undefined) { sets.push(`type = $${i++}`);           vals.push(data.type); }
    if (data.type === "discount_pct" && data.value !== undefined && data.value > 100) return reply.code(400).send({ error: "discount_pct_too_high" });
    if (data.value       !== undefined) { sets.push(`value = $${i++}`);          vals.push(data.value); }
    if (data.pointsCost  !== undefined) { sets.push(`"pointsCost" = $${i++}`);   vals.push(data.pointsCost); }
    if (data.minTier     !== undefined) { sets.push(`"minTier" = $${i++}`);      vals.push(data.minTier); }
    if (data.active      !== undefined) { sets.push(`active = $${i++}`);         vals.push(data.active); }
    if (data.expiresAt   !== undefined) { sets.push(`"expiresAt" = $${i++}::timestamp`); vals.push(normalizeNullableDate(data.expiresAt)); }
    if (data.usageLimit  !== undefined) { sets.push(`"usageLimit" = $${i++}`);   vals.push(data.usageLimit); }
    if (!sets.length) return { ok: true };

    vals.push(id, restaurantId);
    await prisma.$executeRawUnsafe(
      `UPDATE "LoyaltyOffer" SET ${sets.join(", ")} WHERE id = $${i++} AND "restaurantId" = $${i}`,
      ...vals
    );
    return { ok: true };
  });

  // DELETE /loyalty/offers/:id
  app.delete("/loyalty/offers/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const { id } = req.params as { id: string };
    await prisma.$executeRawUnsafe(
      `DELETE FROM "LoyaltyOffer" WHERE id = $1 AND "restaurantId" = $2`, id, restaurantId
    );
    return { ok: true };
  });

  // POST /loyalty/redeem — utiliser une offre pour un client
  app.post("/loyalty/redeem", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const { customerId, offerId } = z.object({
      customerId: z.string(),
      offerId:    z.string(),
    }).parse(req.body);

    const custRows = await prisma.$queryRawUnsafe<Array<{ points: number; tier: string }>>(
      `SELECT points, tier FROM "LoyaltyCustomer" WHERE id = $1 AND "restaurantId" = $2 LIMIT 1`,
      customerId, restaurantId
    );
    const offerRows = await prisma.$queryRawUnsafe<Array<{
      pointsCost: number; minTier: string|null; active: boolean;
      usageLimit: number|null; usageCount: number; expiresAt: string|null;
      name: string; type: string; value: number;
    }>>(
      `SELECT "pointsCost", "minTier", active, "usageLimit", "usageCount", "expiresAt", name, type, value
       FROM "LoyaltyOffer" WHERE id = $1 AND "restaurantId" = $2 LIMIT 1`,
      offerId, restaurantId
    );
    if (!custRows[0]) return reply.code(404).send({ error: "customer_not_found" });
    const customer = custRows[0];
    const offer    = offerRows[0];
    if (!offer)          return reply.code(404).send({ error: "offer_not_found" });
    if (!offer.active)   return reply.code(400).send({ error: "offer_inactive" });
    if (offer.expiresAt && new Date(offer.expiresAt) < new Date()) return reply.code(400).send({ error: "offer_expired" });
    if (offer.usageLimit && offer.usageCount >= offer.usageLimit) return reply.code(400).send({ error: "offer_limit_reached" });
    const TIER_RANK: Record<string,number> = { bronze:0, silver:1, gold:2, platinum:3 };
    if (offer.minTier && (TIER_RANK[customer.tier] ?? 0) < (TIER_RANK[offer.minTier] ?? 0)) {
      return reply.code(400).send({ error: "tier_too_low" });
    }
    if (customer.points < offer.pointsCost) return reply.code(400).send({ error: "insufficient_points" });

    const newPoints = customer.points - offer.pointsCost;
    const newTier   = computeTier(newPoints);

    await prisma.$executeRawUnsafe(
      `UPDATE "LoyaltyCustomer" SET points = $1, tier = $2, "updatedAt" = CURRENT_TIMESTAMP
       WHERE id = $3 AND "restaurantId" = $4`,
      newPoints, newTier, customerId, restaurantId
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "LoyaltyOffer" SET "usageCount" = "usageCount" + 1 WHERE id = $1`, offerId
    );
    const txnId = crypto.randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LoyaltyTransaction" (id, "customerId", "offerId", type, points, description, "createdAt")
       VALUES ($1,$2,$3,'redeem',$4,$5,CURRENT_TIMESTAMP)`,
      txnId, customerId, offerId, -offer.pointsCost,
      `Offre utilisée : ${offer.name}`
    );

    return { ok: true, newPoints, newTier, offer: { name: offer.name, type: offer.type, value: offer.value } };
  });

  // GET /loyalty/stats
  app.get("/loyalty/stats", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;

    const totals = await prisma.$queryRawUnsafe<Array<{
      total: bigint; totalPoints: bigint; totalSpent: number;
    }>>(
      `SELECT COUNT(*)::bigint AS total, SUM(points)::bigint AS "totalPoints",
              SUM("totalSpent") AS "totalSpent"
       FROM "LoyaltyCustomer" WHERE "restaurantId" = $1`,
      restaurantId
    );

    const tiers = await prisma.$queryRawUnsafe<Array<{ tier: string; count: bigint }>>(
      `SELECT tier, COUNT(*)::bigint AS count FROM "LoyaltyCustomer"
       WHERE "restaurantId" = $1 GROUP BY tier`,
      restaurantId
    );

    const recentActivity = await prisma.$queryRawUnsafe<Array<{
      type: string; points: number; description: string|null; createdAt: string;
      firstName: string|null; lastName: string|null;
    }>>(
      `SELECT t.type, t.points, t.description, t."createdAt",
              c."firstName", c."lastName"
       FROM "LoyaltyTransaction" t
       JOIN "LoyaltyCustomer" c ON c.id = t."customerId"
       WHERE c."restaurantId" = $1
       ORDER BY t."createdAt" DESC LIMIT 10`,
      restaurantId
    );

    const offerStats = await prisma.$queryRawUnsafe<Array<{
      total: bigint; active: bigint; totalRedemptions: bigint;
    }>>(
      `SELECT COUNT(*)::bigint AS total,
              SUM(CASE WHEN active THEN 1 ELSE 0 END)::bigint AS active,
              SUM("usageCount")::bigint AS "totalRedemptions"
       FROM "LoyaltyOffer" WHERE "restaurantId" = $1`,
      restaurantId
    );

    return {
      customers: {
        total:      Number(totals[0]?.total ?? 0),
        totalPoints: Number(totals[0]?.totalPoints ?? 0),
        totalSpent:  totals[0]?.totalSpent ?? 0,
      },
      tiers: Object.fromEntries(tiers.map(t => [t.tier, Number(t.count)])),
      offers: {
        total:           Number(offerStats[0]?.total ?? 0),
        active:          Number(offerStats[0]?.active ?? 0),
        totalRedemptions: Number(offerStats[0]?.totalRedemptions ?? 0),
      },
      recentActivity,
    };
  });

  // POST /loyalty/scan-credit — crédit manuel via scan QR carte client
  app.post("/loyalty/scan-credit", { preHandler: requirePro }, async (req) => {
    const { restaurantId } = req.user as { restaurantId: string };
    const { customerId, points, description } = z.object({
      customerId:  z.string().min(1),
      points:      z.number().int().min(1).max(10000),
      description: z.string().optional().default("Crédit manuel — scan carte"),
    }).parse(req.body ?? {});

    // Vérifier que ce client appartient au restaurant
    const customer = await prisma.$queryRawUnsafe<Array<{
      id: string; points: number; tier: string; firstName: string | null; lastName: string | null;
    }>>(
      `SELECT id, points, tier, "firstName", "lastName" FROM "LoyaltyCustomer"
       WHERE id = $1 AND "restaurantId" = $2 LIMIT 1`,
      customerId, restaurantId
    );
    if (!customer[0]) throw Object.assign(new Error("customer_not_found"), { statusCode: 404 });

    const newPts = customer[0].points + points;
    const newTier = newPts >= 5000 ? "platinum" : newPts >= 2000 ? "gold" : newPts >= 500 ? "silver" : "bronze";

    await prisma.$executeRawUnsafe(
      `UPDATE "LoyaltyCustomer" SET points = $1, tier = $2, "visitCount" = "visitCount" + 1, "updatedAt" = NOW() WHERE id = $3`,
      newPts, newTier, customerId
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "LoyaltyTransaction" (id, "customerId", type, points, description, "createdAt")
       VALUES (gen_random_uuid()::text, $1, 'earn', $2, $3, NOW())`,
      customerId, points, description
    );

    return { ok: true, newPoints: newPts, newTier, customer: customer[0] };
  });

  // GET /loyalty/config — lire la config points fidélité
  app.get("/loyalty/config", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const rows = await prisma.$queryRawUnsafe<Array<{
      enabled: boolean; ptsPerEuro: number; minSpendCents: number;
    }>>(
      `SELECT enabled, "ptsPerEuro", "minSpendCents" FROM "LoyaltyConfig"
       WHERE "restaurantId" = $1 LIMIT 1`,
      restaurantId
    );
    return rows[0] ?? { enabled: false, ptsPerEuro: 10, minSpendCents: 0 };
  });

  // PATCH /loyalty/config — mettre à jour la config points fidélité
  app.patch("/loyalty/config", async (req, reply) => {
    const me = await requirePro(req, reply);
    await ensureLoyaltySchema();
    const restaurantId = me.restaurantId;
    const { enabled, ptsPerEuro, minSpendCents } = z.object({
      enabled:       z.boolean().optional(),
      ptsPerEuro:    z.number().int().min(1).max(1000).optional(),
      minSpendCents: z.number().int().min(0).optional(),
    }).parse(req.body ?? {});

    await prisma.$executeRawUnsafe(
      `INSERT INTO "LoyaltyConfig" (id, "restaurantId", enabled, "ptsPerEuro", "minSpendCents", "updatedAt")
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW())
       ON CONFLICT ("restaurantId") DO UPDATE
       SET enabled = COALESCE($2, "LoyaltyConfig".enabled),
           "ptsPerEuro" = COALESCE($3, "LoyaltyConfig"."ptsPerEuro"),
           "minSpendCents" = COALESCE($4, "LoyaltyConfig"."minSpendCents"),
           "updatedAt" = NOW()`,
      restaurantId,
      enabled ?? false,
      ptsPerEuro ?? 10,
      minSpendCents ?? 0
    );
    return { ok: true };
  });

}
