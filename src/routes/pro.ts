import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { requirePro } from "../auth.js";
import { emitToRestaurant } from "../realtime.js";

export async function proRoutes(app: FastifyInstance) {
  app.post("/register", async (req, reply) => {
    const { email, password, restaurantName } = z
      .object({
        email: z.string().email(),
        password: z.string().min(6),
        restaurantName: z.string().min(1),
      })
      .parse(req.body);

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return reply.code(409).send({ error: "email_exists" });

    const passwordHash = await bcrypt.hash(password, 10);
    const restaurant = await prisma.restaurant.create({ data: { name: restaurantName } });
    const user = await prisma.user.create({
      data: { email, passwordHash, restaurantId: restaurant.id },
    });
    return { ok: true, restaurantId: restaurant.id, userId: user.id };
  });

  app.post("/login", async (req, reply) => {
    const { email, password } = z
      .object({ email: z.string().email(), password: z.string().min(6) })
      .parse(req.body);
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const token = app.jwt.sign(
      { kind: "pro", userId: user.id, restaurantId: user.restaurantId },
      { expiresIn: "7d" }
    );
    return { ok: true, token, restaurantId: user.restaurantId };
  });

  app.post("/logout", async () => ({ ok: true }));

  app.get("/me", async (req, reply) => {
    const me = await requirePro(req, reply);
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      include: { openingHours: { orderBy: { dayOfWeek: "asc" } } },
    });
    return { userId: me.userId, restaurant };
  });

  app.get("/tables", async (req, reply) => {
    const me = await requirePro(req, reply);
    const tables = await prisma.table.findMany({
      where: { restaurantId: me.restaurantId },
      orderBy: { number: "asc" },
      include: { sessions: { where: { active: true }, take: 1 } },
    });
    return { tables };
  });

  app.post("/tables", async (req, reply) => {
    const me = await requirePro(req, reply);
    const last = await prisma.table.findFirst({
      where: { restaurantId: me.restaurantId },
      orderBy: { number: "desc" },
    });
    const table = await prisma.table.create({
      data: { number: (last?.number ?? 0) + 1, restaurantId: me.restaurantId },
    });
    return { table };
  });

  app.post("/tables/:id/reset", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const table = await prisma.table.findFirst({ where: { id, restaurantId: me.restaurantId } });
    if (!table) return reply.code(404).send({ error: "not_found" });
    await prisma.tableSession.updateMany({
      where: { tableId: id, active: true },
      data: { active: false, closedAt: new Date() },
    });
    return { ok: true };
  });

  app.post("/tables/:id/settle", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { mode } = z
      .object({ mode: z.enum(["CASH", "COUNTER"]).optional() })
      .parse(req.body ?? {});

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
        active: false,
        closedAt: new Date(),
        billRequestedAt: session.billRequestedAt ?? new Date(),
        billPaymentMode: (mode ?? session.billPaymentMode ?? "COUNTER") as any,
      },
    });

    emitToRestaurant(me.restaurantId, "order:paid", { tableId: id });

    return { ok: true };
  });

  app.get("/orders", async (req, reply) => {
    const me = await requirePro(req, reply);
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const orders = await prisma.order.findMany({
      where: {
        table: { restaurantId: me.restaurantId },
        ...(q.status ? { status: q.status as any } : {}),
      },
      include: { table: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return { orders };
  });

  app.post("/orders/:id/status", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { status } = z
      .object({ status: z.enum(["PENDING", "COOKING", "SERVED", "PAID", "CANCELLED"]) })
      .parse(req.body);
    const order = await prisma.order.findFirst({ where: { id, table: { restaurantId: me.restaurantId } } });
    if (!order) return reply.code(404).send({ error: "not_found" });
    const updated = await prisma.order.update({ where: { id }, data: { status } });
    return { order: updated };
  });

  app.get("/menu", async (req, reply) => {
    const me = await requirePro(req, reply);
    const items = await prisma.menuItem.findMany({
      where: { restaurantId: me.restaurantId },
      orderBy: [{ category: "asc" }, { name: "asc" }],
    });
    return { items };
  });

  app.post("/menu", async (req, reply) => {
    const me = await requirePro(req, reply);
    const data = z.object({
      name: z.string().min(1),
      priceCents: z.number().int().min(0),
      description: z.string().optional(),
      category: z.string().optional(),
      available: z.boolean().default(true),
    }).parse(req.body);
    const item = await prisma.menuItem.create({ data: { ...data, restaurantId: me.restaurantId } });
    return { item };
  });

  app.patch("/menu/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const data = z.object({
      name: z.string().optional(),
      priceCents: z.number().int().optional(),
      description: z.string().optional(),
      category: z.string().optional(),
      available: z.boolean().optional(),
    }).parse(req.body);
    await prisma.menuItem.updateMany({ where: { id, restaurantId: me.restaurantId }, data });
    return { ok: true };
  });

  app.delete("/menu/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    await prisma.menuItem.deleteMany({ where: { id, restaurantId: me.restaurantId } });
    return { ok: true };
  });

  app.patch("/restaurant", async (req, reply) => {
    const me = await requirePro(req, reply);
    const data = z.object({
      name: z.string().optional(),
      slug: z.string().optional(),
      description: z.string().optional(),
      address: z.string().optional(),
      city: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      website: z.string().optional(),
      coverImageUrl: z.string().optional(),
      logoUrl: z.string().optional(),
      acceptReservations: z.boolean().optional(),
      depositPerGuestCents: z.number().optional(),
      openingHours: z.array(z.object({
        dayOfWeek: z.number().int(),
        openMin: z.number().int(),
        closeMin: z.number().int(),
        service: z.string().optional().nullable()
      })).optional()
    }).parse(req.body);

    const updateData: any = { ...data };
    if (data.openingHours !== undefined) {
      updateData.openingHours = {
        deleteMany: {},
        create: data.openingHours.map(h => ({
          ...h,
          service: h.service ?? undefined
        })),
      };
    }

    await prisma.restaurant.update({
      where: { id: me.restaurantId },
      data: updateData,
    });
    return { ok: true };
  });

  app.get("/servers", async (req, reply) => {
    const me = await requirePro(req, reply);
    const servers = await prisma.server.findMany({
      where: { restaurantId: me.restaurantId },
      orderBy: { name: "asc" },
    });
    return { servers };
  });

  app.post("/servers", async (req, reply) => {
    const me = await requirePro(req, reply);
    const data = z.object({
      name: z.string().min(1),
    }).parse(req.body);
    const server = await prisma.server.create({
      data: { ...data, restaurantId: me.restaurantId },
    });
    return { server };
  });

  app.get("/servers/:id/schedules", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const server = await prisma.server.findFirst({
      where: { id, restaurantId: me.restaurantId },
      include: { schedules: true }
    });
    if (!server) return reply.code(404).send({ error: "not_found" });
    return { schedules: server.schedules };
  });

  app.put("/servers/:id/schedules", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    
    const server = await prisma.server.findFirst({ where: { id, restaurantId: me.restaurantId } });
    if (!server) return reply.code(404).send({ error: "not_found" });

    const schedules = z.array(z.object({
      dayOfWeek: z.number().int(),
      openMin: z.number().int(),
      closeMin: z.number().int(),
    })).parse(req.body);

    await prisma.$transaction([
      prisma.serverSchedule.deleteMany({ where: { serverId: id } }),
      prisma.serverSchedule.createMany({
        data: schedules.map(s => ({ ...s, serverId: id }))
      })
    ]);

    return { ok: true };
  });

  app.get("/reservations", async (req, reply) => {
    const me = await requirePro(req, reply);
    const reservations = await prisma.reservation.findMany({
      where: { restaurantId: me.restaurantId },
      include: { table: true },
      orderBy: { startsAt: "asc" },
    });
    return { reservations };
  });

  app.post("/reservations/:id/status", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const { status } = z.object({ status: z.string() }).parse(req.body);
    
    await prisma.reservation.updateMany({
      where: { id, restaurantId: me.restaurantId },
      data: { status },
    });
    return { ok: true };
  });
}
