import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireSessionToken } from "../auth.js";
import { emitToRestaurant } from "../realtime.js";
import { sendEmail, reservationConfirmationHtml, voucherCodeHtml, contactFormHtml, canSendEmail } from "../email.js";
import { getGlobalIaConfig } from "../globalIaConfig.js";
import { setupSSE, ollamaCloudChatStream } from "./ai.js";
import { hasApp } from "../appGating.js";
import { getStripeForRestaurant } from "./stripe.js";
import { env } from "../env.js";
import { randomUUID } from "crypto";
import { getProspectScraperController, isScraperAuthorized } from "../prospectScraper.js";
import { detectFlagsWithRating } from "../reviewFlagger.js";
import { parseQuantityDiscounts, effectiveUnitPriceCents } from "../quantityDiscount.js";
import { parseQuantityTiers, priceForQuantity } from "../quantityTiers.js";

export async function publicRoutes(app: FastifyInstance) {
  app.get("/internal/prospects/scraper", async (req, reply) => {
    const secret = (req.headers["x-scraper-secret"] as string | undefined) || undefined;
    if (!isScraperAuthorized(secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const controller = getProspectScraperController();
    return controller.getState();
  });

  app.post("/internal/prospects/scraper", async (req, reply) => {
    const secret = (req.headers["x-scraper-secret"] as string | undefined) || undefined;
    if (!isScraperAuthorized(secret)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const controller = getProspectScraperController();
    return controller.start();
  });

  /* ── Contact Form from Landing Page ── */
  /**
   * POST /api/public/pricing-request
   * Demande de souscription depuis la landing /tarifs.
   * Le client a sélectionné des modules + une durée d'engagement, on capture
   * tout en DB pour que l'admin puisse rappeler et convertir en contrat.
   */
  app.post("/pricing-request", async (req, reply) => {
    const schema = z.object({
      restaurantName: z.string().min(1, "Nom de l'établissement requis"),
      managerName: z.string().min(1, "Nom du contact requis"),
      email: z.string().email("Email invalide"),
      phone: z.string().optional(),
      city: z.string().optional(),
      selectedModules: z.array(z.string()).min(1, "Au moins un module requis"),
      engagement: z.enum(["3m", "6m", "9m", "12m", "12a"]),
      monthlyHtCents: z.number().int().min(0).default(0),
      totalHtCents: z.number().int().min(0).default(0),
      volumePercent: z.number().int().min(0).max(100).default(0),
      message: z.string().max(2000).optional(),
      sourceUrl: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }
    const d = parsed.data;

    try {
      // Persiste la demande
      const created = await (prisma as any).pricingRequest.create({
        data: {
          restaurantName: d.restaurantName,
          managerName: d.managerName,
          email: d.email,
          phone: d.phone ?? null,
          city: d.city ?? null,
          selectedModules: d.selectedModules,
          engagement: d.engagement,
          monthlyHtCents: d.monthlyHtCents,
          totalHtCents: d.totalHtCents,
          volumePercent: d.volumePercent,
          message: d.message ?? null,
          sourceUrl: d.sourceUrl ?? "matable.pro/tarifs",
        },
      });

      // Notification email à l'équipe MaTable
      if (canSendEmail()) {
        const moduleNames: Record<string, string> = {
          avis: "Avis Google", qr: "Commande & Paiement", server: "Portail Serveur",
          stock: "Nova Stock IA", finance: "Nova Finance IA", contab: "Nova Contab IA",
          reservations: "Réservations",
        };
        const modulesList = d.selectedModules.map((id) => moduleNames[id] ?? id).join(", ");
        const engagementLabel: Record<string, string> = {
          "3m": "3 mois", "6m": "6 mois", "9m": "9 mois",
          "12m": "12 mois", "12a": "12 mois (paiement annuel)",
        };
        const monthly = (d.monthlyHtCents / 100).toFixed(2);
        const total = (d.totalHtCents / 100).toFixed(2);

        await sendEmail({
          to: ["steven@matable.pro", "contact@matable.pro"],
          subject: `🎯 Nouvelle demande : ${d.restaurantName} — ${monthly} €/mois`,
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
              <h2 style="color:#f97316;margin:0 0 16px;">Nouvelle demande de souscription</h2>
              <table style="width:100%;border-collapse:collapse;font-size:14px;">
                <tr><td style="padding:6px;color:#666;width:140px;">Établissement</td><td style="padding:6px;"><b>${d.restaurantName}</b></td></tr>
                <tr><td style="padding:6px;color:#666;">Contact</td><td style="padding:6px;">${d.managerName}</td></tr>
                <tr><td style="padding:6px;color:#666;">Email</td><td style="padding:6px;"><a href="mailto:${d.email}">${d.email}</a></td></tr>
                ${d.phone ? `<tr><td style="padding:6px;color:#666;">Téléphone</td><td style="padding:6px;"><a href="tel:${d.phone}">${d.phone}</a></td></tr>` : ""}
                ${d.city ? `<tr><td style="padding:6px;color:#666;">Ville</td><td style="padding:6px;">${d.city}</td></tr>` : ""}
                <tr><td style="padding:6px;color:#666;border-top:1px solid #eee;">Modules</td><td style="padding:6px;border-top:1px solid #eee;">${modulesList}</td></tr>
                <tr><td style="padding:6px;color:#666;">Engagement</td><td style="padding:6px;"><b>${engagementLabel[d.engagement] ?? d.engagement}</b></td></tr>
                <tr><td style="padding:6px;color:#666;">Mensualité HT</td><td style="padding:6px;color:#f97316;font-weight:900;font-size:18px;">${monthly} €</td></tr>
                <tr><td style="padding:6px;color:#666;">Total période</td><td style="padding:6px;">${total} € HT${d.volumePercent > 0 ? ` (remise volume ${d.volumePercent}%)` : ""}</td></tr>
                ${d.message ? `<tr><td style="padding:6px;color:#666;vertical-align:top;border-top:1px solid #eee;">Message</td><td style="padding:6px;border-top:1px solid #eee;white-space:pre-wrap;">${d.message.replace(/</g, "&lt;")}</td></tr>` : ""}
              </table>
              <p style="margin-top:24px;padding:12px;background:#fff7ed;border-left:4px solid #f97316;font-size:13px;">
                💡 Cette demande est en attente dans <b>/dashboard/demandes</b>. Vous pouvez la convertir en contrat en un clic.
              </p>
            </div>
          `,
          replyTo: d.email,
        });
      }

      return { success: true, requestId: created.id };
    } catch (e: any) {
      req.log.error(e, "Error creating pricing request");
      return reply.status(500).send({ error: "Erreur serveur" });
    }
  });

  app.post("/contact", async (req, reply) => {
    const schema = z.object({
      restaurantName: z.string().min(1, "Nom de l'établissement requis"),
      managerName: z.string().min(1, "Nom du gérant requis"),
      email: z.string().email("Email invalide"),
      message: z.string().min(5, "Message trop court"),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.errors[0].message });
    }

    const { restaurantName, managerName, email, message } = parsed.data;

    try {
      // Create Prospect in DB
      await prisma.prospect.create({
        data: {
          name: restaurantName,
          email: email,
          description: message,
          notes: `Gérant: ${managerName}\n(Depuis formulaire contact matable.pro)`,
          sourceUrl: "matable.pro",
          status: "NEW"
        }
      });

      // Send email notification if possible
      if (canSendEmail()) {
        await sendEmail({
          to: ["steven@matable.pro", "contact@matable.pro"],
          subject: `Nouveau contact : ${restaurantName}`,
          html: contactFormHtml({
            restaurantName,
            managerName,
            email,
            message
          }),
          replyTo: email
        });
      }

      return { success: true };
    } catch (e: any) {
      req.log.error(e, "Error creating prospect");
      return reply.status(500).send({ error: "Erreur serveur" });
    }
  });

  /* ── List all restaurants (for sitemap, public discovery) ── */
  app.get("/restaurants", async (req) => {
    const restaurants = await prisma.restaurant.findMany({
      where: { slug: { not: null } },
      select: {
        id: true,
        slug: true,
        name: true,
        city: true,
        acceptReservations: true,
        updatedAt: true,
      },
      orderBy: { name: "asc" },
    });
    return restaurants;
  });

  app.get("/testimonials", async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(12).optional() })
      .parse(req.query ?? {});

    const testimonials = await prisma.testimonial.findMany({
      where: { published: true },
      orderBy: { updatedAt: "desc" },
      take: limit ?? 3,
      include: { restaurant: { select: { name: true, city: true } } },
    });

    return {
      testimonials: testimonials.map((t) => ({
        id: t.id,
        displayName: t.displayName,
        displayRole: t.displayRole,
        quote: t.quote,
        rating: t.rating,
        restaurantName: t.restaurant.name,
        restaurantCity: t.restaurant.city,
        updatedAt: t.updatedAt,
      })),
    };
  });

  app.get("/media/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const media = await prisma.media.findUnique({ where: { id } });
    if (!media) return reply.code(404).send({ error: "not_found" });

    const buffer = Buffer.from(media.bytes as any);
    reply.header("Content-Type", media.mimeType);
    reply.header("Content-Length", String(buffer.length));
    reply.header("Accept-Ranges", "bytes");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    return reply.send(buffer);
  });

  // ---------------------------------------------------------------------------
  // POST /api/public/r/:slug/review-photo
  // Upload public d'une photo (jusqu'à 5 MB) lors du flow review d'un client.
  // Retourne l'id de la Photo créée, à passer dans dishReviews[].photoIds.
  // ---------------------------------------------------------------------------
  app.post("/r/:slug/review-photo", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const r = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, reviewsEnabled: true },
    });
    if (!r) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!r.reviewsEnabled) return reply.code(403).send({ error: "REVIEWS_DISABLED" });

    const part = await (req as any).file();
    if (!part) return reply.code(400).send({ error: "missing_file" });
    if (typeof part.mimetype !== "string" || !part.mimetype.startsWith("image/")) {
      return reply.code(400).send({ error: "invalid_mime" });
    }
    const buf: Buffer = await part.toBuffer();
    if (!buf.length) return reply.code(400).send({ error: "empty_file" });
    if (buf.length > 5 * 1024 * 1024) return reply.code(400).send({ error: "too_large" });

    const photo = await (prisma as any).photo.create({
      data: {
        restaurantId: r.id,
        kind: "DISH_REVIEW",
        mimeType: part.mimetype,
        bytes: buf,
        size: buf.length,
        originalName: part.filename ?? "review-photo",
      },
      select: { id: true },
    });

    return { id: photo.id, url: `/api/public/photo/${photo.id}` };
  });

  app.get("/photo/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const photo = await prisma.photo.findUnique({ where: { id } });
    if (!photo) return reply.code(404).send({ error: "not_found" });

    const buffer = Buffer.from(photo.bytes as any);
    reply.header("Content-Type", photo.mimeType);
    reply.header("Content-Length", String(buffer.length));
    reply.header("Accept-Ranges", "bytes");
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("Cross-Origin-Resource-Policy", "cross-origin");
    return reply.send(buffer);
  });

  app.get("/tables/:tableId", async (req, reply) => {
    const { tableId } = req.params as { tableId: string };
    const table = await prisma.table.findUnique({
      where: { id: tableId },
      include: {
        assignedServer: { select: { id: true, name: true, photoUrl: true } },
        restaurant: {
          select: {
            id: true,
            name: true,
            slug: true,
            tipsEnabled: true,
            reviewsEnabled: true,
            serviceCallEnabled: true,
            openingHours: { orderBy: { dayOfWeek: "asc" } },
            menuItems: { where: { available: true }, orderBy: { category: "asc" } },
          },
        },
      },
    });
    if (!table) return reply.code(404).send({ error: "table_not_found" });

    // Also check for an active session's server (may differ from default)
    let sessionServer = null;
    const activeSession = await prisma.tableSession.findFirst({
      where: { tableId, active: true },
      include: { server: { select: { id: true, name: true, photoUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    if (activeSession?.server) sessionServer = activeSession.server;

    const server = sessionServer ?? table.assignedServer ?? null;

    return {
      table: { id: table.id, number: table.number, zone: (table as any).zone },
      restaurant: {
        id: table.restaurant.id,
        name: table.restaurant.name,
        slug: (table.restaurant as any).slug,
        tipsEnabled: (table.restaurant as any).tipsEnabled ?? false,
        reviewsEnabled: (table.restaurant as any).reviewsEnabled ?? false,
        serviceCallEnabled: (table.restaurant as any).serviceCallEnabled ?? false,
        openingHours: table.restaurant.openingHours,
      },
      menu: table.restaurant.menuItems.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        priceCents: m.priceCents,
        imageUrl: m.imageUrl,
        category: m.category,
        waitMinutes: (m as any).waitMinutes ?? 0,
        suggestedPairings: (m as any).suggestedPairings ?? [],
        upsellItems: (m as any).upsellItems ?? [],
        quantityDiscounts: parseQuantityDiscounts((m as any).quantityDiscounts),
      })),
      server,
    };
  });

  app.post("/session", async (req, reply) => {
    const { tableId } = z.object({ tableId: z.string().uuid() }).parse(req.body);
    const table = await prisma.table.findUnique({ where: { id: tableId } });
    if (!table) return reply.code(404).send({ error: "table_not_found" });

    let session = await prisma.tableSession.findFirst({
      where: { tableId, active: true },
      orderBy: { createdAt: "desc" },
    });
    if (!session) {
      // Auto-assign the table's default server to the new session
      session = await prisma.tableSession.create({
        data: {
          tableId,
          serverId: (table as any).assignedServerId ?? null,
        },
      });
    }

    const token = await reply.jwtSign(
      {
        kind: "session",
        sessionId: session.id,
        tableId,
        restaurantId: table.restaurantId,
      },
      { expiresIn: "12h" }
    );
    return { token, sessionId: session.id };
  });

  app.get("/r/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      include: {
        menuItems: { where: { available: true }, orderBy: { category: "asc" } },
        openingHours: { orderBy: { dayOfWeek: "asc" } },
        photos: { orderBy: { position: "asc" } },
        servers: {
          include: { schedules: { orderBy: { dayOfWeek: "asc" } } },
        },
      },
    });

    if (!restaurant) {
      return reply.code(404).send({ error: "restaurant_not_found" });
    }

    // Charge les paliers quantite/prix pour chaque plat (colonne extension)
    const menuIds = restaurant.menuItems.map(m => m.id);
    const tiersRows = menuIds.length > 0
      ? await prisma.$queryRaw<Array<{ id: string; quantityTiers: any }>>`
          SELECT id, "quantityTiers" FROM "MenuItem" WHERE id = ANY(${menuIds}::text[])
        `
      : [];
    const tiersById = new Map(tiersRows.map(r => [r.id, parseQuantityTiers(r.quantityTiers)]));

    return {
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
        description: restaurant.description,
        address: restaurant.address,
        city: restaurant.city,
        phone: restaurant.phone,
        email: (restaurant as any).contactEmail || restaurant.email,
        website: restaurant.website,
        coverImageUrl: restaurant.coverImageId ? `/api/media/${restaurant.coverImageId}` : null,
        logoUrl: restaurant.logoId ? `/api/media/${restaurant.logoId}` : null,
        acceptReservations: restaurant.acceptReservations,
        depositPerGuestCents: restaurant.depositPerGuestCents,
        menuItems: restaurant.menuItems.map((m) => ({
          ...m,
          quantityTiers: tiersById.get(m.id) ?? [],
          photos: (restaurant as any).photos
            ?.filter((p: any) => p.menuItemId === m.id && p.kind !== "STAFF")
            .map((p: any) => ({ id: p.id, url: `/api/photo/${p.id}` })) ?? [],
        })),
        openingHours: restaurant.openingHours,
        // STAFF photos are never exposed on the public restaurant page
        photos: (restaurant as any).photos
          ?.filter((p: any) => !p.menuItemId && p.kind !== "STAFF")
          .map((p: any) => ({ id: p.id, url: `/api/photo/${p.id}` })) ?? [],
        servers: restaurant.servers,
      },
      reviews: {
        avgRating: null,
        count: 0,
        latest: [],
      },
    };
  });

  app.get("/r/:slug/availability", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { date, guests, zone } = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().split("T")[0]),
      guests: z.coerce.number().int().min(1).default(2),
      zone: z.string().optional(),
    }).parse(req.query ?? {});

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      include: { openingHours: true },
    });
    if (!restaurant) return reply.code(404).send({ error: "restaurant_not_found" });
    if (!(restaurant as any).acceptReservations) return { slots: [] };

    const d = new Date(date + "T12:00:00");
    const dayOfWeek = d.getDay();
    const dayHours = restaurant.openingHours.filter((h: any) => h.dayOfWeek === dayOfWeek);
    if (!dayHours.length) return { slots: [] };

    const slotMin: number = (restaurant as any).reservationSlotMinutes ?? 30;
    const leadMin: number = (restaurant as any).reservationLeadMinutes ?? 60;
    const mealMin: number = (restaurant as any).avgPrepMinutes ?? 90;
    const now = new Date();

    // ── Charger toutes les tables réservables avec suffisamment de places ──
    const reservableTables = await prisma.table.findMany({
      where: {
        restaurantId: restaurant.id,
        reservable: true,
        seats: { gte: guests },
        ...(zone ? { zone } as any : {}),
      },
      select: { id: true, zone: true },
    });

    if (!reservableTables.length) return { slots: [] };

    // ── Charger les quotas walk-in par zone ──
    const zoneConfigs: { zone: string; minFreeWalkIn: number }[] = await (prisma as any).zoneConfig.findMany({
      where: { restaurantId: restaurant.id },
      select: { zone: true, minFreeWalkIn: true },
    });
    const quotaByZone = new Map<string, number>(zoneConfigs.map((c: any) => [c.zone, c.minFreeWalkIn]));

    // ── Charger toutes les réservations confirmées/en attente de la journée ──
    const dayStart = new Date(date + "T00:00:00");
    const dayEnd   = new Date(date + "T23:59:59");
    const dayReservations = await prisma.reservation.findMany({
      where: {
        restaurantId: restaurant.id,
        startsAt: { gte: dayStart, lte: dayEnd },
        status: { notIn: ["CANCELLED"] },
        tableId: { not: null },
      },
      select: { tableId: true, startsAt: true, durationMin: true, partySize: true },
    });

    const maxCoversPerSlot: number | null = (restaurant as any).maxCoversPerSlot ?? null;

    /**
     * Vérifie si au moins une table réservable peut accueillir une nouvelle
     * réservation sur le créneau [slotStart, slotStart + mealMin], en respectant
     * les quotas walk-in par zone et le plafond de couverts global.
     */
    const canBook = (slotStart: Date): boolean => {
      const slotEnd = new Date(slotStart.getTime() + mealMin * 60_000);

      // Réservations chevauchant ce créneau
      const overlapping = dayReservations.filter((r) => {
        const rEnd = new Date(r.startsAt.getTime() + (r.durationMin ?? mealMin) * 60_000);
        return r.startsAt < slotEnd && rEnd > slotStart;
      });

      // Vérifier le plafond global de couverts
      if (maxCoversPerSlot !== null) {
        const currentCovers = overlapping.reduce((s, r) => s + ((r as any).partySize ?? 0), 0);
        if (currentCovers + guests > maxCoversPerSlot) return false;
      }

      const occupiedTableIds = new Set<string>(overlapping.map((r) => r.tableId as string));

      // Compter par zone : tables libres VS quota walk-in
      const byZone = new Map<string | null, string[]>();
      for (const t of reservableTables) {
        const key = t.zone ?? null;
        if (!byZone.has(key)) byZone.set(key, []);
        byZone.get(key)!.push(t.id);
      }

      for (const [zone, tableIds] of byZone.entries()) {
        const quota = zone !== null ? (quotaByZone.get(zone) ?? 0) : 0;
        const freeTables = tableIds.filter((id) => !occupiedTableIds.has(id));
        const bookable = freeTables.length - quota;
        if (bookable > 0) return true;
      }
      return false;
    };

    const slots: { date: string; time: string; available: boolean }[] = [];

    for (const period of dayHours) {
      let cur: number = (period as any).openMin;
      const lastSlot = (period as any).closeMin - mealMin;
      while (cur <= lastSlot) {
        const slotDate = new Date(date + "T00:00:00");
        slotDate.setHours(Math.floor(cur / 60), cur % 60, 0, 0);
        const time = `${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`;
        const afterLeadTime = slotDate.getTime() > now.getTime() + leadMin * 60_000;
        const tableAvailable = afterLeadTime && canBook(slotDate);
        slots.push({ date, time, available: tableAvailable });
        cur += slotMin;
      }
    }

    return { slots };
  });

  // ---------------------------------------------------------------------------
  // GET /api/public/r/:slug/zones — zones réservables disponibles
  // ---------------------------------------------------------------------------
  app.get("/r/:slug/zones", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (!restaurant) return reply.code(404).send({ error: "restaurant_not_found" });

    const tables = await prisma.table.findMany({
      where: { restaurantId: restaurant.id, reservable: true },
      select: { zone: true },
    });

    // Zones uniques non-null, triées
    const zones = [...new Set(
      tables.map((t: any) => t.zone).filter((z: any): z is string => !!z)
    )].sort();

    return { zones };
  });

  // ---------------------------------------------------------------------------
  // GET /api/public/r/:slug/loyalty — consultation points client
  // ---------------------------------------------------------------------------
  app.get("/r/:slug/loyalty", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { q } = z.object({ q: z.string().min(1) }).parse(req.query ?? {});

    const restaurant = await prisma.restaurant.findUnique({ where: { slug }, select: { id: true } });
    if (!restaurant) return reply.code(404).send({ error: "restaurant_not_found" });

    const term = q.trim().toLowerCase();

    // Chercher par email ou téléphone
    const customers = await prisma.$queryRawUnsafe<Array<{
      id: string; firstName: string|null; lastName: string|null;
      email: string|null; phone: string|null;
      points: number; tier: string; totalSpent: number; visitCount: number;
    }>>(
      `SELECT id, "firstName", "lastName", email, phone, points, tier, "totalSpent", "visitCount"
       FROM "LoyaltyCustomer"
       WHERE "restaurantId" = $1
         AND (LOWER(COALESCE(email,'')) = $2 OR REPLACE(REPLACE(phone,' ',''),'.','') LIKE $3)
       LIMIT 1`,
      restaurant.id, term, `%${term.replace(/[\s.+\-()]/g, "")}%`
    );

    if (!customers[0]) return reply.code(404).send({ error: "not_found" });
    const customer = customers[0];

    // Transactions récentes
    const transactions = await prisma.$queryRawUnsafe<Array<{
      id: string; type: string; points: number; description: string|null; createdAt: string;
    }>>(
      `SELECT id, type, points, description, "createdAt"::text FROM "LoyaltyTransaction"
       WHERE "customerId" = $1 ORDER BY "createdAt" DESC LIMIT 20`,
      customer.id
    );

    // Offres actives du restaurant
    const offers = await prisma.$queryRawUnsafe<Array<{
      id: string; name: string; description: string|null; type: string;
      pointsCost: number; minTier: string|null; active: boolean;
    }>>(
      `SELECT id, name, description, type, "pointsCost", "minTier", active
       FROM "LoyaltyOffer" WHERE "restaurantId" = $1 AND active = true
       ORDER BY "pointsCost" ASC`,
      restaurant.id
    );

    return { customer: { ...customer, transactions, offers } };
  });

  // ---------------------------------------------------------------------------
  // GET /api/public/r/:slug/review-campaign
  // Returns configuration for the interactive review flow (servers, link, voucher)
  // ---------------------------------------------------------------------------
  app.get("/r/:slug/review-campaign", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    
    // Check main restaurant via Prisma
    const r = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, name: true, reviewsEnabled: true, tipsEnabled: true },
    });
    
    if (!r) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!r.reviewsEnabled) return reply.code(403).send({ error: "REVIEWS_DISABLED" });

    // Get specific configuration fields via raw query because they are not in prisma schema yet
    const configRaw = await prisma.$queryRawUnsafe<any[]>(
      `SELECT "googleReviewLink", "reviewVoucherConfig", "businessType", "reviewCustomQuestions", "reviewRatingCategories" FROM "Restaurant" WHERE id = $1`, r.id
    );
    const googleReviewLink = configRaw[0]?.googleReviewLink || null;
    const reviewVoucherConfig = configRaw[0]?.reviewVoucherConfig || null;
    const businessType: string = configRaw[0]?.businessType || "RESTAURANT";
    const reviewCustomQuestions: string | null = configRaw[0]?.reviewCustomQuestions || null;
    const reviewRatingCategories = Array.isArray(configRaw[0]?.reviewRatingCategories) ? configRaw[0].reviewRatingCategories : [];

    // Get list of active servers with their photos
    const servers = await prisma.server.findMany({
      where: { restaurantId: r.id, active: true },
      select: { id: true, name: true, photoUrl: true }
    });

    // Get restaurant photos (uploaded in config) — exclude staff portraits
    const photos = await (prisma as any).photo.findMany({
      where: {
        restaurantId: r.id,
        menuItemId: null,
        kind: { not: "STAFF" },
      },
      orderBy: { position: "asc" },
      select: { id: true },
    });

    return {
      restaurant: {
        id: r.id,
        name: r.name,
        photos: photos.map((p: any) => ({ id: p.id, url: `/api/photo/${p.id}` })),
      },
      googleReviewLink,
      tipsEnabled: r.tipsEnabled,
      reviewVoucherConfig,
      businessType,
      reviewCustomQuestions,
      reviewRatingCategories,
      servers
    };
  });

  // ---------------------------------------------------------------------------
  // GET /api/public/r/:slug/review-menu
  // Light menu list for the review flow's dish picker (id, name, category, price)
  // ---------------------------------------------------------------------------
  app.get("/r/:slug/review-menu", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const r = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, reviewsEnabled: true },
    });
    if (!r) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!r.reviewsEnabled) return reply.code(403).send({ error: "REVIEWS_DISABLED" });

    const items = await prisma.menuItem.findMany({
      where: { restaurantId: r.id, available: true },
      orderBy: [{ category: "asc" }, { position: "asc" }],
      select: {
        id: true,
        name: true,
        category: true,
        priceCents: true,
        imageUrl: true,
      },
    });

    return { items };
  });

  // ---------------------------------------------------------------------------
  // POST /api/public/r/:slug/review-feedback
  // Public endpoint: client laisse une note serveur + plats depuis le flow review
  // (sans token de session de table - pour avis spontanés via QR review)
  // → crée ServerReview + DishReview visibles dans le dashboard du resto
  // ---------------------------------------------------------------------------
  app.post("/r/:slug/review-feedback", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = z.object({
      serverId: z.string().optional(),
      serverRating: z.number().int().min(1).max(5).optional(),
      serverComment: z.string().max(800).optional(),
      dishReviews: z.array(z.object({
        menuItemId: z.string(),
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(800).optional(),
        photoIds: z.array(z.string()).max(5).optional(),
      })).optional(),
    }).parse(req.body ?? {});

    const r = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, reviewsEnabled: true },
    });
    if (!r) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!r.reviewsEnabled) return reply.code(403).send({ error: "REVIEWS_DISABLED" });

    let serverReviewId: string | null = null;
    const dishReviewIds: string[] = [];

    // Server review
    if (body.serverRating && body.serverId) {
      const server = await prisma.server.findFirst({
        where: { id: body.serverId, restaurantId: r.id },
        select: { id: true, name: true },
      });
      if (server) {
        const flags = detectFlagsWithRating(body.serverRating, body.serverComment);
        const created = await prisma.serverReview.create({
          data: {
            restaurantId: r.id,
            serverId: server.id,
            rating: body.serverRating,
            comment: body.serverComment ?? null,
            flagged: flags.flagged,
            flagReasons: flags.reasons,
          },
          select: { id: true, rating: true, comment: true, createdAt: true, flagged: true, flagReasons: true },
        });
        serverReviewId = created.id;

        emitToRestaurant(r.id, "review:new", {
          kind: "server",
          review: {
            id: created.id,
            rating: created.rating,
            comment: created.comment,
            createdAt: created.createdAt,
            flagged: created.flagged,
            flagReasons: created.flagReasons,
            server: { id: server.id, name: server.name },
          },
        });

        if (created.flagged) {
          emitToRestaurant(r.id, "review:flagged", {
            kind: "server",
            id: created.id,
            reasons: created.flagReasons,
            label: server.name,
            rating: created.rating,
            comment: created.comment,
            createdAt: created.createdAt,
          });
        }
      }
    }

    // Dish reviews
    if (body.dishReviews && body.dishReviews.length > 0) {
      const validItems = await prisma.menuItem.findMany({
        where: {
          restaurantId: r.id,
          id: { in: body.dishReviews.map((d) => d.menuItemId) },
        },
        select: { id: true, name: true },
      });
      const validById = new Map(validItems.map((m) => [m.id, m]));

      // Validate photoIds belong to this restaurant
      const allPhotoIds = Array.from(new Set(body.dishReviews.flatMap(d => d.photoIds ?? [])));
      const validPhotos = allPhotoIds.length
        ? await (prisma as any).photo.findMany({
            where: { id: { in: allPhotoIds }, restaurantId: r.id },
            select: { id: true },
          })
        : [];
      const validPhotoSet = new Set<string>(validPhotos.map((p: any) => p.id));

      for (const dr of body.dishReviews) {
        const item = validById.get(dr.menuItemId);
        if (!item) continue;

        const cleanPhotoIds = (dr.photoIds ?? []).filter(id => validPhotoSet.has(id));
        const flags = detectFlagsWithRating(dr.rating, dr.comment);

        const created = await prisma.dishReview.create({
          data: {
            restaurantId: r.id,
            menuItemId: dr.menuItemId,
            rating: dr.rating,
            comment: dr.comment ?? null,
            photoIds: cleanPhotoIds,
            flagged: flags.flagged,
            flagReasons: flags.reasons,
            verified: false,
          },
          select: { id: true, rating: true, comment: true, photoIds: true, flagged: true, flagReasons: true, createdAt: true },
        });
        dishReviewIds.push(created.id);

        emitToRestaurant(r.id, "review:new", {
          kind: "dish",
          review: {
            id: created.id,
            rating: created.rating,
            comment: created.comment,
            photoIds: created.photoIds,
            flagged: created.flagged,
            flagReasons: created.flagReasons,
            createdAt: created.createdAt,
            menuItem: { id: item.id, name: item.name },
          },
        });

        if (created.flagged) {
          emitToRestaurant(r.id, "review:flagged", {
            kind: "dish",
            id: created.id,
            reasons: created.flagReasons,
            label: item.name,
            rating: created.rating,
            comment: created.comment,
            createdAt: created.createdAt,
          });
        }
      }
    }

    return {
      ok: true,
      serverReviewId,
      dishReviewIds,
    };
  });

  // ---------------------------------------------------------------------------
  // POST /api/ia/review-chat — Chat conversationnel IA pour récolter des avis
  // ---------------------------------------------------------------------------
  app.post("/ia/review-chat", async (req, reply) => {
    const body = z.object({
      restaurantId: z.string().min(1),
      serverName: z.string().min(1),
      // Accept arbitrary category keys (defaults: food/service/atmosphere/value,
      // plus any custom categories configured by the pro).
      ratings: z.record(z.string(), z.number().min(0).max(5)),
      history: z.array(z.object({
        role: z.enum(["ai", "user"]),
        content: z.string()
      })),
      businessType: z.enum(["RESTAURANT", "BOUTIQUE"]).optional().default("RESTAURANT"),
      customQuestions: z.string().optional(),
      // Optional human labels for each rating key (sent by the public review page so the
      // prompt mentions the same wording the customer saw on screen).
      ratingLabels: z.record(z.string(), z.string()).optional(),
    }).parse(req.body);

    const { send, close } = setupSSE(reply);

    try {
      const iaConfig = await getGlobalIaConfig();
      if (!iaConfig.ollamaApiKey) throw new Error("No API Key configured globally");

      const isFinalTurn = body.history.filter(m => m.role === "user").length >= 2;
      const isBoutique = body.businessType === "BOUTIQUE";
      const entityLabel = isBoutique ? "établissement" : "restaurant";
      // Default human-readable labels per key (used when ratingLabels not provided).
      const defaultLabels: Record<string, string> = isBoutique
        ? { food: "Produits/Services", service: "Accueil", atmosphere: "Ambiance", value: "Qualité/Prix" }
        : { food: "Cuisine", service: "Service", atmosphere: "Ambiance", value: "Qualité/Prix" };
      const labelOf = (key: string) => body.ratingLabels?.[key] ?? defaultLabels[key] ?? key;
      const ratingLabels = Object.entries(body.ratings)
        .filter(([, v]) => Number(v) > 0)
        .map(([k, v]) => `${labelOf(k)}: ${v}`)
        .join(", ");
      const userAnswerCount = body.history.filter(m => m.role === "user").length;

      const availableTopics = [
        {
          key: "food",
          label: labelOf("food"),
          score: body.ratings.food ?? 0,
          positiveQuestion: isBoutique ? "Quel produit ou service vous a le plus marqué ?" : "Quel plat vous a le plus marqué ?",
          neutralQuestion: isBoutique ? "Comment avez-vous trouvé la qualité des produits ?" : "Comment avez-vous trouvé la cuisine ?",
          negativeQuestion: isBoutique ? "Qu'est-ce qui pourrait être amélioré côté produit ?" : "Qu'est-ce qui pourrait être amélioré côté cuisine ?",
          choices: isBoutique ? ["Très qualitatif", "Correct", "Pas assez convaincant"] : ["Excellent", "Correct", "Décevant"],
        },
        {
          key: "service",
          label: labelOf("service"),
          score: body.ratings.service ?? 0,
          positiveQuestion: `Qu'avez-vous apprécié chez ${body.serverName} ?`,
          neutralQuestion: isBoutique ? "Comment s'est passé l'accueil ?" : "Comment s'est passé le service ?",
          negativeQuestion: isBoutique ? "Qu'est-ce qui a manqué dans l'accueil ?" : "Qu'est-ce qui a manqué dans le service ?",
          choices: ["Très chaleureux", "Correct", "À améliorer"],
        },
        {
          key: "atmosphere",
          label: labelOf("atmosphere"),
          score: body.ratings.atmosphere ?? 0,
          positiveQuestion: "Qu'avez-vous aimé dans l'ambiance ?",
          neutralQuestion: "Comment avez-vous trouvé l'ambiance ?",
          negativeQuestion: "Qu'est-ce qui a gêné l'ambiance ?",
          choices: ["Très agréable", "Plutôt calme", "Pas assez confortable"],
        },
        {
          key: "value",
          label: labelOf("value"),
          score: body.ratings.value ?? 0,
          positiveQuestion: "Le rapport qualité/prix vous a-t-il semblé juste ?",
          neutralQuestion: "Que pensez-vous du rapport qualité/prix ?",
          negativeQuestion: "Qu'est-ce qui justifie votre note prix ?",
          choices: ["Très bon", "Correct", "Trop élevé"],
        },
        ...Object.entries(body.ratings)
          .filter(([key, score]) => !["food", "service", "atmosphere", "value"].includes(key) && score > 0)
          .map(([key, score]) => ({
            key,
            label: labelOf(key),
            score,
            positiveQuestion: `Qu'avez-vous apprécié concernant ${labelOf(key)} ?`,
            neutralQuestion: `Comment avez-vous trouvé ${labelOf(key)} ?`,
            negativeQuestion: `Qu'est-ce qui pourrait être amélioré concernant ${labelOf(key)} ?`,
            choices: ["Très bien", "Correct", "À améliorer"],
          })),
      ].filter(t => t.score > 0);

      const customTopics = (body.customQuestions ?? "")
        .split(/[\n;,]+/)
        .map(s => s.trim())
        .filter(Boolean)
        .slice(0, 4);

      const prioritizedTopics = [...availableTopics]
        .sort((a, b) => {
          const aNeedsFollowUp = a.score > 0 && a.score <= 3 ? 0 : 1;
          const bNeedsFollowUp = b.score > 0 && b.score <= 3 ? 0 : 1;
          if (aNeedsFollowUp !== bNeedsFollowUp) return aNeedsFollowUp - bNeedsFollowUp;
          if (aNeedsFollowUp === 0) return a.score - b.score;
          return b.score - a.score;
        })
        .map(t => {
          const question = t.score <= 3 ? t.negativeQuestion : t.score >= 5 ? t.positiveQuestion : t.neutralQuestion;
          return `${t.label} (${t.score}/5) -> ${question} | ${t.choices.join(" | ")}`;
        });

      const selectedTopicHint = prioritizedTopics[userAnswerCount] ?? prioritizedTopics[0];

      let prompt = `Tu es l'assistant virtuel parfait d'un ${entityLabel}, chargé de récolter les avis clients de manière chaleureuse.
Notes du client (sur 5) : ${ratingLabels}.
${isBoutique ? `Membre de l'équipe : ${body.serverName}.` : `Serveur : ${body.serverName}.`}
${isBoutique && body.customQuestions ? `L'établissement souhaite que tu explores particulièrement : ${body.customQuestions}.` : ""}

`;
      if (body.history.length > 0) {
        prompt += "Historique:\n";
        body.history.forEach(m => {
          prompt += `${m.role === 'ai' ? 'Toi' : 'Client'}: ${m.content}\n`;
        });
      }

      if (isFinalTurn) {
        prompt += `
INSTRUCTION : Le client a répondu à tes questions. Tu dois maintenant GÉNÉRER L'AVIS FINAL.
L'avis doit être naturel${!isBoutique ? ", mentionner le prénom du serveur," : ""} et refléter les notes et les réponses du client.
Ne renvoie STRICTEMENT rien d'autre que ce JSON (pas de bloc markdown) :
{
  "version1": "Texte court de l'avis 1",
  "version2": "Texte court de l'avis 2"
}`;
      } else {
        const topicHint = customTopics.length > 0 && userAnswerCount === 1
          ? `Questionne aussi le thème personnalisé suivant, sans ignorer les notes : ${customTopics[0]}.`
          : `Utilise ce topic prioritaire exactement comme base : ${selectedTopicHint}.`;
        prompt += `
TOPICS DISPONIBLES, classés par pertinence selon les notes :
${prioritizedTopics.map((t, i) => `${i + 1}. ${t}`).join("\n")}
${customTopics.length > 0 ? `Topics personnalisés du restaurant : ${customTopics.join(" | ")}` : ""}

INSTRUCTION : ${topicHint}
Pose UNE SEULE question ciblée et très courte (maximum 15 mots).
La question doit correspondre à une note réellement donnée :
- note 1 à 3 : demande ce qui n'a pas marché ou ce qui doit être amélioré ;
- note 4 à 5 : demande ce qui a plu ou ce qu'il faut mettre en avant ;
- ne pose pas de question hors sujet (ex: prix si la mauvaise note est service).
N'utilise pas de politesse excessive.
Propose ensuite exactement 3 suggestions de réponses courtes séparées par le caractère " | ".
Format attendu STRICTEMENT :
<Ta question> | <Choix 1> | <Choix 2> | <Choix 3>

Exemple:
${isBoutique ? "La sélection de produits vous a-t-elle surpris ? | Oui, très originale | Classique mais bon | Quelques découvertes" : "La cuisson de votre viande était-elle à votre goût ? | Parfaite | Un peu trop cuite | Saignante à souhait"}`;
      }

      const fullOutput = await ollamaCloudChatStream(
        iaConfig.ollamaApiKey,
        iaConfig.ollamaLangModel || "llama3.3",
        [{ role: "user", content: prompt }],
        (chunk) => { send({ type: "chunk", text: chunk }); },
      );

      if (isFinalTurn) {
        try {
          const reviewId = randomUUID();
          await prisma.$executeRawUnsafe(
            `INSERT INTO "CustomerReview" (id, "restaurantId", "serverName", ratings, "reviewText", "chatHistory", "createdAt") VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, NOW())`,
            reviewId, body.restaurantId, body.serverName, JSON.stringify(body.ratings), fullOutput, JSON.stringify(body.history)
          );
          emitToRestaurant(body.restaurantId, "review:new", {
            kind: "customer",
            review: {
              id: reviewId,
              serverName: body.serverName,
              ratings: body.ratings,
              reviewText: fullOutput,
              chatHistory: body.history,
              createdAt: new Date().toISOString(),
            },
          });
        } catch (dbErr) {
          console.error("Error saving CustomerReview:", dbErr);
        }
      }

      send({ type: "done", text: fullOutput });
      close();
    } catch (err: any) {
      console.error("[IA] review-chat error:", err);
      send({ type: "error", message: err.message || "Unknown error" });
      close();
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/ia/review-draft — Générateur d'avis Google IA (Public, no auth)
  // Called by the client review page (/r/[slug]/review) via SSE streaming
  // ---------------------------------------------------------------------------
  app.post("/ia/review-draft", async (req, reply) => {
    const body = z.object({
      restaurantId: z.string().min(1),
      serverName: z.string().min(1),
      rating: z.number().int().min(1).max(5),
      answers: z.array(z.string()).max(10),
    }).parse(req.body);

    // Setup SSE to keep connection alive on Railway (railway kills silent conns after 60s)
    const { send, close } = setupSSE(reply);

    try {
      const p = `Tu es un rédacteur d'avis Google parfait et authentique.
Un client vient de manger dans notre restaurant.
Voici le contexte :
- Note donnée : ${body.rating}/5
- Serveur qui s'est occupé de lui : ${body.serverName}
- Ses réponses aux questions sur son expérience : ${body.answers.join(" | ")}

Génère 2 versions courtes, naturelles et différentes d'un avis Google basé sur ce contexte.
L'avis doit faire entre 20 et 50 mots maximum. Il doit mentionner le nom du serveur.
Ne renvoie STRICTEMENT rien d'autre que ce JSON (pas de bloc Markdown \`\`\`json):
{
  "version1": "Texte du premier avis",
  "version2": "Texte du deuxième avis"
}`;

      const iaConfig = await getGlobalIaConfig();
      if (!iaConfig.ollamaApiKey) throw new Error("No API Key configured globally");

      const fullOutput = await ollamaCloudChatStream(
        iaConfig.ollamaApiKey,
        iaConfig.ollamaLangModel || "llama3.3",
        [{ role: "user", content: p }],
        (chunk) => { send({ type: "chunk", text: chunk }); },
      );

      // Clean and parse the output. Some models wrap JSON in prose despite the prompt.
      const cleanJson = fullOutput.replace(/```json/g, "").replace(/```/g, "").trim();
      const jsonStart = cleanJson.indexOf("{");
      const jsonEnd = cleanJson.lastIndexOf("}");
      const jsonCandidate = jsonStart >= 0 && jsonEnd > jsonStart
        ? cleanJson.slice(jsonStart, jsonEnd + 1)
        : cleanJson;

      let result: { version1?: string; version2?: string };
      try {
        result = JSON.parse(jsonCandidate);
      } catch {
        const base = `Super expérience, accueil ${body.answers[0]?.toLowerCase() || "très agréable"}, plats ${body.answers[1]?.toLowerCase() || "très bons"} et ambiance ${body.answers[2]?.toLowerCase() || "réussie"}. Merci à ${body.serverName} pour le service.`;
        result = {
          version1: base,
          version2: `Très bon moment dans ce restaurant. Le service de ${body.serverName} était attentionné, les plats étaient ${body.answers[1]?.toLowerCase() || "très bons"} et l'ambiance ${body.answers[2]?.toLowerCase() || "agréable"}. Je recommande.`,
        };
      }

      if (!result.version1 || !result.version2) {
        result.version1 ||= `Très bonne expérience, merci à ${body.serverName} pour le service. Les plats étaient ${body.answers[1]?.toLowerCase() || "très bons"} et l'accueil ${body.answers[0]?.toLowerCase() || "agréable"}.`;
        result.version2 ||= `Nous avons passé un très bon moment. Service ${body.answers[0]?.toLowerCase() || "agréable"} avec ${body.serverName}, cuisine ${body.answers[1]?.toLowerCase() || "savoureuse"} et ambiance ${body.answers[2]?.toLowerCase() || "réussie"}.`;
      }

      send({
        type: "done",
        version1: result.version1,
        version2: result.version2,
      });
      close();
    } catch (err: any) {
      console.error("[IA] review-draft error:", err);
      send({ type: "error", message: err.message || "Unknown error" });
      close();
    }
  });

  // ---------------------------------------------------------------------------
  // POST /api/r/:slug/tip — Pourboire public via Stripe Checkout (Apple Pay / Google Pay)
  // Called from the review page after QR code scan — no auth required
  // ---------------------------------------------------------------------------
  app.post("/r/:slug/tip", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const body = z.object({
      amountCents: z.number().int().min(100).max(50000), // 1€ min, 500€ max
      serverName: z.string().min(1),
      serverId: z.string().optional(),
    }).parse(req.body);

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, name: true, tipsEnabled: true },
    });
    if (!restaurant) return reply.code(404).send({ error: "restaurant_not_found" });
    if (!restaurant.tipsEnabled) return reply.code(403).send({ error: "tips_disabled" });

    const { stripe } = await getStripeForRestaurant(restaurant.id);
    if (!stripe) return reply.code(503).send({ error: "stripe_not_configured" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "eur",
          product_data: {
            name: `Pourboire pour ${body.serverName}`,
            description: `${restaurant.name}`,
          },
          unit_amount: body.amountCents,
        },
      }],
      success_url: `${env.PUBLIC_WEB_URL}/r/${slug}/review?tip=success&amount=${body.amountCents}`,
      cancel_url: `${env.PUBLIC_WEB_URL}/r/${slug}/review?tip=cancel`,
      metadata: {
        type: "tip",
        restaurantId: restaurant.id,
        serverId: body.serverId ?? "",
        serverName: body.serverName,
        slug,
      },
    });

    return { url: session.url };
  });

  // ---------------------------------------------------------------------------
  // POST /api/r/:slug/voucher-request — envoie un code 6 chiffres par email
  // Le code est stocké en mémoire avec TTL de 10 min
  // ---------------------------------------------------------------------------
  const voucherCodes = new Map<string, { code: string; restaurantId: string; expiresAt: number }>();

  app.post("/r/:slug/voucher-request", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const emailLower = email.trim().toLowerCase();

    const restaurant = await prisma.restaurant.findUnique({ where: { slug }, select: { id: true, name: true } });
    if (!restaurant) return reply.code(404).send({ error: "restaurant_not_found" });

    // Récupérer le code voucher actuel du restaurant
    const configRaw = await prisma.$queryRawUnsafe<any[]>(
      `SELECT "reviewVoucherConfig" FROM "Restaurant" WHERE id = $1`, restaurant.id
    );
    const currentVoucherCode = configRaw[0]?.reviewVoucherConfig?.code ?? null;

    // Check si cet email a déjà réclamé un voucher AVEC LE MÊME code promo
    // Si le resto a changé le code, l'ancien claim ne bloque plus
    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM "CustomerReview" WHERE "restaurantId" = $1 AND "contactEmail" = $2 AND "voucherClaimed" = true AND "voucherCode" = $3 LIMIT 1`,
      restaurant.id, emailLower, currentVoucherCode
    );
    if (existing.length > 0) {
      return reply.code(409).send({ error: "already_claimed", message: "Vous avez déjà bénéficié de cette offre." });
    }

    if (!canSendEmail()) {
      return reply.code(503).send({ error: "email_not_configured" });
    }

    // Générer code 6 chiffres
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const key = `${restaurant.id}:${emailLower}`;
    voucherCodes.set(key, { code, restaurantId: restaurant.id, expiresAt: Date.now() + 10 * 60 * 1000 });

    // Cleanup codes expirés (lazy)
    for (const [k, v] of voucherCodes) {
      if (v.expiresAt < Date.now()) voucherCodes.delete(k);
    }

    await sendEmail({
      to: emailLower,
      subject: `Votre code de vérification — ${restaurant.name}`,
      html: voucherCodeHtml({ restaurantName: restaurant.name, code }),
    });

    return { ok: true };
  });

  // ---------------------------------------------------------------------------
  // POST /api/r/:slug/voucher-verify — vérifie le code, marque le voucher comme réclamé
  // ---------------------------------------------------------------------------
  app.post("/r/:slug/voucher-verify", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { email, code } = z.object({ email: z.string().email(), code: z.string().length(6) }).parse(req.body);
    const emailLower = email.trim().toLowerCase();

    const restaurant = await prisma.restaurant.findUnique({ where: { slug }, select: { id: true, name: true } });
    if (!restaurant) return reply.code(404).send({ error: "restaurant_not_found" });

    const key = `${restaurant.id}:${emailLower}`;
    const stored = voucherCodes.get(key);

    if (!stored || stored.code !== code) {
      return reply.code(400).send({ error: "invalid_code", message: "Code incorrect ou expiré." });
    }
    if (stored.expiresAt < Date.now()) {
      voucherCodes.delete(key);
      return reply.code(400).send({ error: "expired", message: "Code expiré. Demandez-en un nouveau." });
    }

    // Récupérer le code voucher actuel pour le stocker dans le claim
    const cfgRaw = await prisma.$queryRawUnsafe<any[]>(
      `SELECT "reviewVoucherConfig" FROM "Restaurant" WHERE id = $1`, restaurant.id
    );
    const voucherConfig = cfgRaw[0]?.reviewVoucherConfig || null;
    const claimedCode = voucherConfig?.code ?? null;

    // Marquer le dernier CustomerReview de ce restaurant comme "claimed" avec l'email + le code promo utilisé
    // On prend le plus récent non-claimed
    await prisma.$executeRawUnsafe(
      `UPDATE "CustomerReview" SET "contactEmail" = $1, "voucherClaimed" = true, "voucherCode" = $3
       WHERE id = (
         SELECT id FROM "CustomerReview"
         WHERE "restaurantId" = $2 AND ("contactEmail" IS NULL OR "contactEmail" = $1)
         AND "voucherClaimed" = false
         ORDER BY "createdAt" DESC LIMIT 1
       )`,
      emailLower, restaurant.id, claimedCode
    );

    // Supprimer le code utilisé
    voucherCodes.delete(key);

    return { ok: true, voucher: voucherConfig };
  });

  app.post("/r/:slug/reservations", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const input = z.object({
      name: z.string().min(1),
      phone: z.string(),
      email: z.string().email().optional(),
      date: z.string(), // ISO date
      time: z.string(), // HH:mm
      guests: z.number().int().min(1),
      zone: z.string().optional().nullable(), // zone préférée
    }).parse(req.body);

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, name: true, address: true, phone: true, avgPrepMinutes: true },
    }) as any;
    if (!restaurant) {
      return reply.code(404).send({ error: "restaurant_not_found" });
    }

    // Check if reservations app is enabled
    const canReserve = await hasApp(restaurant.id, "reservations");
    if (!canReserve) {
      return reply.code(403).send({ error: "APP_NOT_ENABLED", app: "reservations" });
    }

    const [hours, mins] = input.time.split(":").map(Number);
    const startsAt = new Date(input.date);
    startsAt.setHours(hours, mins, 0, 0);

    const mealMin: number = (restaurant as any).avgPrepMinutes ?? 90;
    const slotEnd = new Date(startsAt.getTime() + mealMin * 60_000);

    // ── Trouver la meilleure table disponible en respectant les quotas ────────
    const reservableTables = await prisma.table.findMany({
      where: {
        restaurantId: restaurant.id,
        reservable: true,
        seats: { gte: input.guests },
        // Si une zone est demandée, filtrer dessus
        ...(input.zone ? { zone: input.zone } as any : {}),
      },
      select: { id: true, zone: true, seats: true },
      orderBy: { seats: "asc" }, // préférer la table la plus petite qui convient
    });

    // Tables déjà occupées sur ce créneau
    const overlapping = await prisma.reservation.findMany({
      where: {
        restaurantId: restaurant.id,
        status: { notIn: ["CANCELLED"] },
        tableId: { not: null },
        startsAt: { lt: slotEnd },
      },
      select: { tableId: true, startsAt: true, durationMin: true },
    });
    const occupiedIds = new Set<string>(
      overlapping
        .filter((r) => {
          const rEnd = new Date(r.startsAt.getTime() + (r.durationMin ?? mealMin) * 60_000);
          return rEnd > startsAt;
        })
        .map((r) => r.tableId as string)
    );

    // Charger quotas walk-in
    const zoneConfigs: { zone: string; minFreeWalkIn: number }[] = await (prisma as any).zoneConfig.findMany({
      where: { restaurantId: restaurant.id },
      select: { zone: true, minFreeWalkIn: true },
    });
    const quotaByZone = new Map<string, number>(zoneConfigs.map((c: any) => [c.zone, c.minFreeWalkIn]));

    // Grouper par zone pour vérifier le quota
    const byZone = new Map<string | null, typeof reservableTables>();
    for (const t of reservableTables) {
      const key = t.zone ?? null;
      if (!byZone.has(key)) byZone.set(key, []);
      byZone.get(key)!.push(t);
    }

    let assignedTableId: string | null = null;
    for (const [zone, tables] of byZone.entries()) {
      const quota = zone !== null ? (quotaByZone.get(zone) ?? 0) : 0;
      const freeTables = tables.filter((t) => !occupiedIds.has(t.id));
      if (freeTables.length - quota > 0) {
        assignedTableId = freeTables[0].id; // première table libre qui respecte le quota
        break;
      }
    }

    if (!assignedTableId) {
      return reply.code(409).send({ error: "no_table_available" });
    }

    const reservation = await prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        startsAt,
        partySize: input.guests,
        customerName: input.name,
        customerEmail: input.email ?? "",
        customerPhone: input.phone,
        status: "PENDING",
        tableId: assignedTableId,
      },
    });

    // Notifier le dashboard en temps réel
    emitToRestaurant(restaurant.id, "reservation:new", {
      id:           reservation.id,
      customerName: input.name,
      partySize:    input.guests,
      startsAt:     reservation.startsAt,
      source:       "online",
    });

    // Send confirmation email if customer provided email + Resend is configured
    if (input.email && canSendEmail()) {
      const dateFormatted = startsAt.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      const html = reservationConfirmationHtml({
        restaurantName: restaurant.name,
        customerName: input.name,
        date: dateFormatted,
        time: input.time,
        guests: input.guests,
        restaurantAddress: (restaurant as any).address ?? null,
        restaurantPhone: (restaurant as any).phone ?? null,
      });
      // Non-blocking — don't fail the request if email fails
      sendEmail({
        to: input.email,
        from: "reservations@matable.pro",
        subject: `Réservation confirmée · ${restaurant.name}`,
        html,
      }).catch(err => console.error("[email] reservation confirmation failed:", err));
    }

    // Alerte email au restaurateur si configurée
    const alertRows = await prisma.$queryRaw<Array<{ reservationAlertEmail: string | null; reservationAlertEmails: unknown | null }>>`
      SELECT "reservationAlertEmail", "reservationAlertEmails" FROM "Restaurant" WHERE id = ${restaurant.id} LIMIT 1
    `.catch(() => []);
    const alertEmails = Array.from(new Set([
      ...(Array.isArray(alertRows[0]?.reservationAlertEmails) ? alertRows[0]?.reservationAlertEmails as string[] : []),
      ...(alertRows[0]?.reservationAlertEmail ? [alertRows[0].reservationAlertEmail] : []),
    ].map(e => String(e).trim().toLowerCase()).filter(Boolean)));
    if (alertEmails.length > 0 && canSendEmail()) {
      const dateFormatted = startsAt.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      const alertHtml = `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
          <h2 style="margin:0 0 16px;font-size:20px">🔔 Nouvelle réservation — ${restaurant.name}</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#666;width:130px">Client</td><td style="padding:6px 0;font-weight:600">${input.name}</td></tr>
            <tr><td style="padding:6px 0;color:#666">Date</td><td style="padding:6px 0">${dateFormatted} à ${input.time}</td></tr>
            <tr><td style="padding:6px 0;color:#666">Couverts</td><td style="padding:6px 0">${input.guests}</td></tr>
            ${input.phone ? `<tr><td style="padding:6px 0;color:#666">Téléphone</td><td style="padding:6px 0">${input.phone}</td></tr>` : ""}
            ${input.email ? `<tr><td style="padding:6px 0;color:#666">Email</td><td style="padding:6px 0">${input.email}</td></tr>` : ""}
          </table>
          <p style="margin:16px 0 0;font-size:12px;color:#999">
            Gérez vos réservations sur <a href="https://matable.pro/dashboard/reservations">matable.pro/dashboard</a>
          </p>
        </div>`;
      sendEmail({
        to: alertEmails.join(","),
        from: "reservations@matable.pro",
        subject: `🔔 Nouvelle réservation · ${input.name} · ${input.guests} cvt · ${input.time}`,
        html: alertHtml,
      }).catch(err => console.error("[email] reservation alert failed:", err));
    }

    return { ok: true, reservationId: reservation.id };
  });

  app.post("/orders", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const body = z
      .object({
        items: z
          .array(z.object({
            menuItemId: z.string(),
            quantity: z.number().int().min(1),
            // qty du palier explicitement choisi par le client (optionnel)
            selectedTierQty: z.number().int().min(1).max(9999).optional(),
          }))
          .min(1),
      })
      .parse(req.body);

    const session = await prisma.tableSession.findUnique({ where: { id: decoded.sessionId } });
    if (!session || !session.active) return reply.code(401).send({ error: "session_closed" });

    const menuItems = await prisma.menuItem.findMany({
      where: {
        id: { in: body.items.map((i) => i.menuItemId) },
        restaurantId: decoded.restaurantId,
        available: true,
      },
    });
    const byId = new Map(menuItems.map((m) => [m.id, m]));

    // Read quantity discount tiers + new quantity TIERS (qty → priceCents)
    // Both columns managed via ensure_columns.sql.
    const menuItemIdsForDiscount = body.items.map((i) => i.menuItemId);
    type DiscRow = { id: string; quantityDiscounts: any; quantityTiers: any };
    const discRows = menuItemIdsForDiscount.length === 0 ? [] : await prisma.$queryRaw<DiscRow[]>`
      SELECT id, "quantityDiscounts", "quantityTiers" FROM "MenuItem" WHERE id = ANY(${menuItemIdsForDiscount}::text[])
    `;
    const tiersById = new Map(discRows.map((r) => [r.id, parseQuantityDiscounts(r.quantityDiscounts)]));
    const qtyTiersById = new Map(discRows.map((r) => [r.id, parseQuantityTiers(r.quantityTiers)]));

    // Le client peut envoyer un champ "selectedTierQty" pour indiquer qu'il a clique
    // sur un palier explicitement (ex: il a choisi "3 unites = 22€"). Dans ce cas
    // on facture le prix du palier. Sinon, fallback sur quantite × prix de base
    // (en respectant les anciennes remises % si presentes).
    const lines = body.items.map((i: any) => {
      const m = byId.get(i.menuItemId);
      if (!m) throw reply.code(400).send({ error: "unknown_item" });

      const qtyTiers = qtyTiersById.get(m.id) ?? [];
      const selectedTierQty = typeof i.selectedTierQty === "number" ? i.selectedTierQty : null;

      // Cas 1 : le client a clique sur un palier specifique
      if (selectedTierQty !== null && qtyTiers.length > 0) {
        const matched = qtyTiers.find(t => t.qty === selectedTierQty);
        if (matched) {
          // Le prix total du palier divise par la quantite = "prix unitaire effectif"
          // (necessaire car le reste du code utilise priceCents × quantity).
          // On force quantity = matched.qty pour que totalCents soit correct.
          const unit = Math.round(matched.priceCents / matched.qty);
          return {
            menuItemId: m.id,
            name: m.name,
            quantity: matched.qty,
            priceCents: unit,
            // Adjustment cents pour compenser les arrondis (max ±1c × qty)
            _totalOverride: matched.priceCents,
          };
        }
      }

      // Cas 2 : pas de palier choisi → ancienne logique % de remise
      const oldTiers = tiersById.get(m.id) ?? [];
      const unit = effectiveUnitPriceCents(m.priceCents, i.quantity, oldTiers);
      return { menuItemId: m.id, name: m.name, quantity: i.quantity, priceCents: unit };
    });
    const totalCents = lines.reduce((s: number, l: any) => {
      if (typeof l._totalOverride === "number") return s + l._totalOverride;
      return s + l.priceCents * l.quantity;
    }, 0);

    // Compute expectedReadyAt: now + max(waitMinutes) across ordered items
    // waitMinutes is added via ensure_columns.sql, use raw query to read it
    const menuItemIds = body.items.map((i) => i.menuItemId);
    type WaitRow = { id: string; waitMinutes: number };
    let waitRows: WaitRow[] = [];
    if (menuItemIds.length > 0) {
      waitRows = await prisma.$queryRaw<WaitRow[]>`
        SELECT id, COALESCE("waitMinutes", 0)::int AS "waitMinutes"
        FROM "MenuItem" WHERE id = ANY(${menuItemIds}::text[])
      `;
    }
    const waitMap = new Map(waitRows.map((r) => [r.id, r.waitMinutes]));
    const maxWait = Math.max(0, ...body.items.map((i) => waitMap.get(i.menuItemId) ?? 0));
    const expectedReadyAt = maxWait > 0 ? new Date(Date.now() + maxWait * 60_000) : null;

    const order = await prisma.order.create({
      data: {
        tableId: decoded.tableId,
        sessionId: decoded.sessionId,
        items: lines,
        totalCents,
      },
      include: { table: true },
    });

    // Store expectedReadyAt via raw (column added by ensure_columns.sql)
    if (expectedReadyAt) {
      await prisma.$executeRaw`
        UPDATE "Order" SET "expectedReadyAt" = ${expectedReadyAt} WHERE id = ${order.id}
      `;
    }

    emitToRestaurant(decoded.restaurantId, "order:new", {
      id: order.id,
      tableId: order.tableId,
      tableNumber: order.table.number,
      items: lines,
      totalCents,
      createdAt: order.createdAt,
      status: order.status,
      expectedReadyAt,
    });

    return { orderId: order.id, totalCents, expectedReadyAt };
  });

  app.get("/orders/mine", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const orders = await prisma.order.findMany({
      where: { sessionId: decoded.sessionId },
      orderBy: { createdAt: "desc" },
    });

    // Attach expectedReadyAt from raw (column added by ensure_columns.sql)
    const ids = orders.map((o) => o.id);
    type EtaRow = { id: string; expectedReadyAt: Date | null };
    let etaRows: EtaRow[] = [];
    if (ids.length > 0) {
      etaRows = await prisma.$queryRaw<EtaRow[]>`
        SELECT id, "expectedReadyAt" FROM "Order" WHERE id = ANY(${ids}::text[])
      `;
    }
    const etaMap = new Map(etaRows.map((r) => [r.id, r.expectedReadyAt]));

    return {
      orders: orders.map((o) => ({
        ...o,
        expectedReadyAt: etaMap.get(o.id) ?? null,
      })),
    };
  });

  app.post("/bill/request", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const { mode } = z
      .object({ mode: z.enum(["CARD", "CASH", "COUNTER"]).default("CARD") })
      .parse(req.body ?? {});

    const session = await prisma.tableSession.findUnique({
      where: { id: decoded.sessionId },
      include: { table: true },
    });
    if (!session || !session.active) return reply.code(401).send({ error: "session_closed" });

    await prisma.tableSession.update({
      where: { id: decoded.sessionId },
      data: { billRequestedAt: new Date(), billPaymentMode: mode as any },
    });

    emitToRestaurant(decoded.restaurantId, "bill:requested", {
      tableId: decoded.tableId,
      tableNumber: session.table.number,
      mode,
    });

    return { ok: true };
  });

  // ── Tip ─────────────────────────────────────────────────────────────────────
  app.post("/tip", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const { amountCents } = z.object({ amountCents: z.number().int().min(50).max(50000) }).parse(req.body);

    const session = await prisma.tableSession.findUnique({ where: { id: decoded.sessionId } });
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    await prisma.tableSession.update({
      where: { id: decoded.sessionId },
      data: { tipCents: (session.tipCents ?? 0) + amountCents },
    });

    // Also credit the server if assigned
    if (session.serverId) {
      // Update any open orders to include tip (spread across latest order)
      const latestOrder = await prisma.order.findFirst({
        where: { sessionId: decoded.sessionId, status: { not: "CANCELLED" } },
        orderBy: { createdAt: "desc" },
      });
      if (latestOrder) {
        await prisma.order.update({
          where: { id: latestOrder.id },
          data: { tipCents: (latestOrder.tipCents ?? 0) + amountCents },
        });
      }
    }

    emitToRestaurant(decoded.restaurantId, "tip:received", {
      tableId: decoded.tableId,
      sessionId: decoded.sessionId,
      amountCents,
      serverId: session.serverId,
    });

    return { ok: true, totalTipCents: (session.tipCents ?? 0) + amountCents };
  });

  // ── Reviews ─────────────────────────────────────────────────────────────────
  app.post("/reviews", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const body = z.object({
      serverRating: z.number().int().min(1).max(5).optional(),
      serverComment: z.string().max(500).optional(),
      dishReviews: z.array(z.object({
        menuItemId: z.string(),
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(500).optional(),
      })).optional(),
    }).parse(req.body);

    const session = await prisma.tableSession.findUnique({ where: { id: decoded.sessionId } });
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    // Find the latest order for this session
    const latestOrder = await prisma.order.findFirst({
      where: { sessionId: decoded.sessionId, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
    });

    // Server review
    if (body.serverRating && session.serverId) {
      await prisma.serverReview.create({
        data: {
          restaurantId: decoded.restaurantId,
          serverId: session.serverId,
          orderId: latestOrder?.id,
          rating: body.serverRating,
          comment: body.serverComment ?? null,
        },
      });
    }

    // Dish reviews
    if (body.dishReviews && body.dishReviews.length > 0) {
      for (const dr of body.dishReviews) {
        await prisma.dishReview.create({
          data: {
            restaurantId: decoded.restaurantId,
            menuItemId: dr.menuItemId,
            orderId: latestOrder?.id,
            rating: dr.rating,
            comment: dr.comment ?? null,
          },
        });
      }
    }

    return { ok: true };
  });

  // ── Service call ────────────────────────────────────────────────────────────
  app.post("/service-call", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const { reason } = z.object({ reason: z.string().max(200).default("Appel serveur") }).parse(req.body ?? {});

    const table = await prisma.table.findUnique({ where: { id: decoded.tableId } });
    if (!table) return reply.code(404).send({ error: "table_not_found" });

    const call = await prisma.serviceCall.create({
      data: {
        restaurantId: decoded.restaurantId,
        tableId: decoded.tableId,
        sessionId: decoded.sessionId,
        reason,
      },
    });

    emitToRestaurant(decoded.restaurantId, "service:called", {
      id: call.id,
      tableId: decoded.tableId,
      tableNumber: table.number,
      reason,
    });

    return { ok: true, callId: call.id };
  });
}
