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
  app.post("/register", async (req, reply) => {
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
    const restaurant = await prisma.restaurant.create({ data: { name: restaurantName, slug } });
    await prisma.user.create({ data: { email, passwordHash, restaurantId: restaurant.id } });
    return { ok: true, restaurantId: restaurant.id, slug };
  });

  app.post("/login", async (req, reply) => {
    const { email, password } = z.object({
      email: z.string().email(),
      password: z.string().min(6),
    }).parse(req.body);
    
    console.log("[login] attempt for email:", email);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash || !user.restaurantId) {
      console.log("[login] user not found / no password / no restaurant:", email);
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const matches = await bcrypt.compare(password, user.passwordHash);
    if (!matches) {
      console.log("[login] password mismatch for:", email);
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    const token = app.jwt.sign(
      { kind: "pro", userId: user.id, restaurantId: user.restaurantId },
      { expiresIn: "7d" }
    );
    console.log("[login] success for:", email);
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
      coverImageUrl: z.string().url().optional(),
      logoUrl: z.string().url().optional(),
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
        service: z.string().optional(),
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
        service: z.string().optional(),
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
    }).default({}).parse(req.body ?? {});
    const last = await prisma.table.findFirst({
      where: { restaurantId: me.restaurantId },
      orderBy: { number: "desc" },
    });
    const table = await prisma.table.create({
      data: { number: (last?.number ?? 0) + 1, restaurantId: me.restaurantId, seats: body.seats ?? 2, label: body.label },
    });
    return { table };
  });

  app.patch("/tables/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const data = z.object({ seats: z.number().int().min(1).max(20).optional(), label: z.string().max(40).optional() }).parse(req.body);
    await prisma.table.updateMany({ where: { id, restaurantId: me.restaurantId }, data });
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
    return { items };
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
    position: z.number().int().optional(),
  });

  app.post("/menu", async (req, reply) => {
    const me = await requirePro(req, reply);
    const data = menuInput.parse(req.body);
    const item = await prisma.menuItem.create({
      data: { ...data, imageUrl: data.imageUrl || null, restaurantId: me.restaurantId } as any,
    });
    return { item };
  });

  app.patch("/menu/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const data = menuInput.partial().parse(req.body);
    if (data.imageUrl === "") (data as any).imageUrl = null;
    await prisma.menuItem.updateMany({ where: { id, restaurantId: me.restaurantId }, data: data as any });
    return { ok: true };
  });

  app.delete("/menu/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    await prisma.menuItem.deleteMany({ where: { id, restaurantId: me.restaurantId } });
    return { ok: true };
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
}
