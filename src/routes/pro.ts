import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { prisma } from "../db.js";
import { requirePro } from "../auth.js";
import { emitToRestaurant, emitToSession } from "../realtime.js";

const ALLERGENS = [
  "GLUTEN","CRUSTACEANS","EGGS","FISH","PEANUTS","SOYBEANS","MILK","NUTS",
  "CELERY","MUSTARD","SESAME","SULPHITES","LUPIN","MOLLUSCS",
] as const;
const DIETS = [
  "VEGETARIAN","VEGAN","GLUTEN_FREE","LACTOSE_FREE","HALAL","KOSHER",
  "PORK_FREE","LOW_CAL","SPICY",
] as const;

const slugify = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
   .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

export async function proRoutes(app: FastifyInstance) {

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------
  const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } };

  app.post("/register", authRateLimit, async (req, reply) => {
    const { email, password, restaurantName } = z.object({
      email: z.string().email(),
      password: z.string().min(6),
      restaurantName: z.string().min(1),
    }).parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return reply.code(409).send({ error: "email_exists" });

    const base = slugify(restaurantName) || "resto";
    let slug = base, i = 1;
    while (await prisma.restaurant.findUnique({ where: { slug } })) slug = `${base}-${++i}`;

    const passwordHash = await bcrypt.hash(password, 10);
    const { restaurant, user } = await prisma.$transaction(async (tx) => {
      const restaurant = await tx.restaurant.create({ data: { name: restaurantName, slug } });
      const user = await tx.user.create({ data: { email, passwordHash, restaurantId: restaurant.id } });
      return { restaurant, user };
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

  app.get("/me", async (req, reply) => {
    const me = await requirePro(req, reply);
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      include: { openingHours: { orderBy: [{ dayOfWeek: "asc" }, { openMin: "asc" }] } },
    });
    return { userId: me.userId, restaurant };
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
      reservationSlotMinutes: z.number().int().min(10).max(120).optional(),
      tipsEnabled: z.boolean().optional(),
      serviceCallEnabled: z.boolean().optional(),
      reviewsEnabled: z.boolean().optional(),
      openingHours: z.array(z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        openMin: z.number().int().min(0).max(1440),
        closeMin: z.number().int().min(0).max(1440),
        service: z.string().nullable().optional(),
      })).optional(),
    }).parse(req.body);

    const { openingHours, ...restData } = body;

    if (restData.slug) {
      const taken = await prisma.restaurant.findFirst({
        where: { slug: restData.slug, NOT: { id: me.restaurantId } },
      });
      if (taken) return reply.code(409).send({ error: "slug_taken" });
    }

    const ops: any[] = [
      prisma.restaurant.update({ where: { id: me.restaurantId }, data: restData }),
    ];
    if (openingHours !== undefined) {
      ops.push(prisma.openingHour.deleteMany({ where: { restaurantId: me.restaurantId } }));
      if (openingHours.length > 0) {
        ops.push(prisma.openingHour.createMany({
          data: openingHours.map((h) => ({ ...h, restaurantId: me.restaurantId })),
        }));
      }
    }
    const [restaurant] = await prisma.$transaction(ops);
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
    const { status } = z.object({ status: z.enum(["PENDING", "COOKING", "SERVED", "PAID", "CANCELLED"]) }).parse(req.body);
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
    type ExtRow = { id: string; waitMinutes: number; suggestedPairings: any; upsellItems: any };
    let extRows: ExtRow[] = [];
    if (ids.length > 0) {
      extRows = await prisma.$queryRaw<ExtRow[]>`
        SELECT id, 
               COALESCE("waitMinutes", 0)::int AS "waitMinutes",
               "suggestedPairings",
               "upsellItems"
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
          upsellItems: ext?.upsellItems ?? []
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
  });

  app.post("/menu", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { waitMinutes, suggestedPairings, upsellItems, ...data } = menuInput.parse(req.body);
    const item = await prisma.menuItem.create({
      data: { ...data, imageUrl: data.imageUrl || null, restaurantId: me.restaurantId } as any,
    });
    
    // Extensions managed via ensure_columns.sql (not in Prisma schema)
    const updates: string[] = [];
    if (waitMinutes !== undefined) updates.push(`"waitMinutes" = ${Number(waitMinutes)}`);
    if (suggestedPairings !== undefined) updates.push(`"suggestedPairings" = '${JSON.stringify(suggestedPairings)}'::jsonb`);
    if (upsellItems !== undefined) updates.push(`"upsellItems" = '${JSON.stringify(upsellItems)}'::jsonb`);
    
    if (updates.length > 0) {
      await prisma.$executeRawUnsafe(`UPDATE "MenuItem" SET ${updates.join(", ")} WHERE id = $1`, item.id);
    }
    
    return { item: { ...item, waitMinutes: waitMinutes ?? 0, suggestedPairings: suggestedPairings ?? [], upsellItems: upsellItems ?? [] } };
  });

  app.patch("/menu/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { waitMinutes, suggestedPairings, upsellItems, ...data } = menuInput.partial().parse(req.body);
    if (data.imageUrl === "") (data as any).imageUrl = null;
    
    if (Object.keys(data).length > 0) {
      await prisma.menuItem.updateMany({ where: { id, restaurantId: me.restaurantId }, data: data as any });
    }

    // Extensions managed via ensure_columns.sql
    const updates: string[] = [];
    if (waitMinutes !== undefined) updates.push(`"waitMinutes" = ${Number(waitMinutes)}`);
    if (suggestedPairings !== undefined) updates.push(`"suggestedPairings" = '${JSON.stringify(suggestedPairings)}'::jsonb`);
    if (upsellItems !== undefined) updates.push(`"upsellItems" = '${JSON.stringify(upsellItems)}'::jsonb`);
    
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
    const ordersCount = paidOrders.length;
    const avgTicketCents = ordersCount ? Math.round(revenueCents / ordersCount) : 0;
    const itemCounts = new Map<string, { name: string; qty: number; revenueCents: number }>();
    for (const o of paidOrders) {
      for (const it of (o.items as any[])) {
        const prev = itemCounts.get(it.name) ?? { name: it.name, qty: 0, revenueCents: 0 };
        prev.qty += it.quantity; prev.revenueCents += it.priceCents * it.quantity;
        itemCounts.set(it.name, prev);
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
    return { sinceIso: since.toISOString(), revenueCents, ordersCount, avgTicketCents, topItems, revenueByDay,
      revenueByServer: Array.from(byServer.values()).sort((a, b) => b.revenueCents - a.revenueCents) };
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
      kind: z.enum(["RESTAURANT", "DISH"]).optional(),
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

}
