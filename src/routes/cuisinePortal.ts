/**
 * Cuisine Portal Routes — /api/cuisine/*
 *
 * Authentication: cuisine login with restaurant slug + PIN (stored on Restaurant.cuisinePin)
 * POST /api/cuisine/login         { slug, pin } → JWT cuisine token (8h)
 * GET  /api/cuisine/orders        → active orders (PENDING + COOKING) grouped by table/session
 * POST /api/cuisine/orders/:id/cooking  → mark order as COOKING
 * POST /api/cuisine/orders/:id/served   → mark order as SERVED
 * GET  /api/cuisine/stats         → orders count today per status
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";
import jwt from "jsonwebtoken";
import { emitToRestaurant } from "../realtime.js";

type CuisineJwt = { restaurantId: string; role: "cuisine" };

function signCuisineToken(payload: CuisineJwt): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "8h" });
}

async function requireCuisine(req: any, reply: any): Promise<CuisineJwt> {
  const auth = req.headers?.authorization as string | undefined;
  if (!auth?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "UNAUTHORIZED" });
    throw new Error("Unauthorized");
  }
  try {
    const payload = jwt.verify(auth.slice(7), env.JWT_SECRET) as CuisineJwt;
    if (payload.role !== "cuisine") {
      reply.code(403).send({ error: "FORBIDDEN" });
      throw new Error("Forbidden");
    }
    return payload;
  } catch {
    reply.code(401).send({ error: "INVALID_TOKEN" });
    throw new Error("Invalid token");
  }
}

export async function cuisinePortalRoutes(app: FastifyInstance) {

  // ── POST /api/cuisine/login ────────────────────────────────────────────────
  app.post("/login", async (req, reply) => {
    const { slug, pin } = z.object({
      slug: z.string(),
      pin: z.string().min(4).max(8),
    }).parse(req.body);

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, name: true },
    });
    if (!restaurant) return reply.code(404).send({ error: "RESTAURANT_NOT_FOUND" });

    const rows = await prisma.$queryRaw<Array<{ cuisinePin: string | null }>>`
      SELECT "cuisinePin" FROM "Restaurant" WHERE id = ${restaurant.id}
    `;
    const storedPin = rows[0]?.cuisinePin ?? null;

    if (!storedPin) return reply.code(503).send({ error: "CUISINE_NOT_CONFIGURED", message: "PIN cuisine non configuré. Contactez le gérant." });
    if (storedPin !== pin) return reply.code(401).send({ error: "INVALID_PIN" });

    const token = signCuisineToken({ restaurantId: restaurant.id, role: "cuisine" });
    return { token, restaurant: { id: restaurant.id, name: restaurant.name } };
  });

  // ── GET /api/cuisine/orders ────────────────────────────────────────────────
  // Active orders (PENDING + COOKING) with table info
  app.get("/orders", async (req, reply) => {
    const me = await requireCuisine(req, reply);

    const orders = await prisma.order.findMany({
      where: {
        table: { restaurantId: me.restaurantId },
        status: { in: ["PENDING", "COOKING"] },
      },
      include: {
        table: { select: { number: true, zone: true } },
        session: {
          select: {
            id: true,
            server: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return { orders };
  });

  // ── GET /api/cuisine/stats ─────────────────────────────────────────────────
  app.get("/stats", async (req, reply) => {
    const me = await requireCuisine(req, reply);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [pending, cooking, served, paid] = await Promise.all([
      prisma.order.count({ where: { table: { restaurantId: me.restaurantId }, status: "PENDING", createdAt: { gte: today } } }),
      prisma.order.count({ where: { table: { restaurantId: me.restaurantId }, status: "COOKING", createdAt: { gte: today } } }),
      prisma.order.count({ where: { table: { restaurantId: me.restaurantId }, status: "SERVED", createdAt: { gte: today } } }),
      prisma.order.count({ where: { table: { restaurantId: me.restaurantId }, status: "PAID", createdAt: { gte: today } } }),
    ]);

    return { pending, cooking, served, paid, total: pending + cooking + served + paid };
  });

  // ── POST /api/cuisine/orders/:id/cooking ──────────────────────────────────
  app.post("/orders/:id/cooking", async (req, reply) => {
    const me = await requireCuisine(req, reply);
    const { id } = req.params as { id: string };

    const order = await prisma.order.findFirst({
      where: { id, table: { restaurantId: me.restaurantId }, status: "PENDING" },
    });
    if (!order) return reply.code(404).send({ error: "ORDER_NOT_FOUND" });

    await prisma.order.update({ where: { id }, data: { status: "COOKING" } });
    emitToRestaurant(me.restaurantId, "order:updated", { orderId: id, status: "COOKING" });

    return { ok: true };
  });

  // ── POST /api/cuisine/orders/:id/served ───────────────────────────────────
  app.post("/orders/:id/served", async (req, reply) => {
    const me = await requireCuisine(req, reply);
    const { id } = req.params as { id: string };

    const order = await prisma.order.findFirst({
      where: { id, table: { restaurantId: me.restaurantId }, status: "COOKING" },
    });
    if (!order) return reply.code(404).send({ error: "ORDER_NOT_FOUND" });

    await prisma.order.update({ where: { id }, data: { status: "SERVED" } });
    emitToRestaurant(me.restaurantId, "order:updated", { orderId: id, status: "SERVED" });

    return { ok: true };
  });
}
