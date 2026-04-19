import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "@atable/db";
import { requirePro } from "../auth.js";

export async function proRoutes(app: FastifyInstance) {
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
    reply.setCookie("atable_pro", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return { ok: true, restaurantId: user.restaurantId };
  });

  app.post("/logout", async (_req, reply) => {
    reply.clearCookie("atable_pro", { path: "/" });
    return { ok: true };
  });

  app.get("/me", async (req, reply) => {
    const me = await requirePro(req, reply);
    const restaurant = await prisma.restaurant.findUnique({ where: { id: me.restaurantId } });
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
    const next = (last?.number ?? 0) + 1;
    const table = await prisma.table.create({
      data: { number: next, restaurantId: me.restaurantId },
    });
    return { table };
  });

  app.post("/tables/:id/reset", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const table = await prisma.table.findFirst({
      where: { id, restaurantId: me.restaurantId },
    });
    if (!table) return reply.code(404).send({ error: "not_found" });
    await prisma.tableSession.updateMany({
      where: { tableId: id, active: true },
      data: { active: false, closedAt: new Date() },
    });
    return { ok: true };
  });

  app.get("/orders", async (req, reply) => {
    const me = await requirePro(req, reply);
    const q = z
      .object({ status: z.string().optional() })
      .parse(req.query);
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
    const order = await prisma.order.findFirst({
      where: { id, table: { restaurantId: me.restaurantId } },
    });
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
    const data = z
      .object({
        name: z.string().min(1),
        priceCents: z.number().int().min(0),
        description: z.string().optional(),
        category: z.string().optional(),
        available: z.boolean().default(true),
      })
      .parse(req.body);
    const item = await prisma.menuItem.create({
      data: { ...data, restaurantId: me.restaurantId },
    });
    return { item };
  });

  app.patch("/menu/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const data = z
      .object({
        name: z.string().optional(),
        priceCents: z.number().int().optional(),
        description: z.string().optional(),
        category: z.string().optional(),
        available: z.boolean().optional(),
      })
      .parse(req.body);
    const item = await prisma.menuItem.updateMany({
      where: { id, restaurantId: me.restaurantId },
      data,
    });
    return { updated: item.count };
  });

  app.delete("/menu/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };
    const res = await prisma.menuItem.deleteMany({
      where: { id, restaurantId: me.restaurantId },
    });
    return { deleted: res.count };
  });
}
