/**
 * Caisse Portal Routes — /api/caisse/*
 *
 * Authentication: caisse login with restaurant slug + PIN (stored on Restaurant.caissePin)
 * POST /api/caisse/login      { slug, pin } → JWT caisse token (8h)
 * GET  /api/caisse/sessions   → all active sessions with items + totals
 * GET  /api/caisse/stats      → daily revenue, payment breakdown
 * POST /api/caisse/sessions/:id/close  { paymentMode } → close session, mark orders PAID
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";
import jwt from "jsonwebtoken";

type CaisseJwt = { restaurantId: string; role: "caisse" };

function signCaisseToken(payload: CaisseJwt): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "8h" });
}

async function requireCaisse(req: any, reply: any): Promise<CaisseJwt> {
  const auth = req.headers?.authorization as string | undefined;
  if (!auth?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "UNAUTHORIZED" });
    throw new Error("Unauthorized");
  }
  try {
    const payload = jwt.verify(auth.slice(7), env.JWT_SECRET) as CaisseJwt;
    if (payload.role !== "caisse") {
      reply.code(403).send({ error: "FORBIDDEN" });
      throw new Error("Forbidden");
    }
    return payload;
  } catch {
    reply.code(401).send({ error: "INVALID_TOKEN" });
    throw new Error("Invalid token");
  }
}

export async function caissePortalRoutes(app: FastifyInstance) {

  // ── POST /api/caisse/login ─────────────────────────────────────────────────
  app.post("/login", async (req, reply) => {
    const { slug, pin } = z.object({
      slug: z.string(),
      pin: z.string().min(4).max(8),
    }).parse(req.body);

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, name: true, caissePin: true } as any,
    });

    if (!restaurant) return reply.code(404).send({ error: "RESTAURANT_NOT_FOUND" });
    if (!(restaurant as any).caissePin) return reply.code(503).send({ error: "CAISSE_NOT_CONFIGURED", message: "PIN caisse non configuré. Contactez le gérant." });
    if ((restaurant as any).caissePin !== pin) return reply.code(401).send({ error: "INVALID_PIN" });

    const token = signCaisseToken({ restaurantId: restaurant.id, role: "caisse" });
    return { token, restaurant: { id: restaurant.id, name: restaurant.name } };
  });

  // ── GET /api/caisse/sessions ───────────────────────────────────────────────
  // All active sessions with active orders
  app.get("/sessions", async (req, reply) => {
    const me = await requireCaisse(req, reply);

    const sessions = await prisma.tableSession.findMany({
      where: { table: { restaurantId: me.restaurantId }, active: true },
      include: {
        table: { select: { number: true, seats: true, zone: true } },
        server: { select: { id: true, name: true } },
        orders: {
          where: { status: { in: ["PENDING", "COOKING", "SERVED"] } },
          include: { items: true },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Compute totals
    const enriched = sessions.map((s) => {
      const totalCents = s.orders.reduce((sum, o) => sum + o.totalCents, 0);
      const hasUnserved = s.orders.some(o => o.status !== "SERVED");
      return { ...s, totalCents, hasUnserved };
    });

    return { sessions: enriched };
  });

  // ── GET /api/caisse/stats ──────────────────────────────────────────────────
  app.get("/stats", async (req, reply) => {
    const me = await requireCaisse(req, reply);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [ordersToday, closedToday, activeCount] = await Promise.all([
      prisma.order.aggregate({
        where: { table: { restaurantId: me.restaurantId }, status: "PAID", createdAt: { gte: today } },
        _sum: { totalCents: true },
        _count: { _all: true },
      }),
      prisma.tableSession.findMany({
        where: { table: { restaurantId: me.restaurantId }, active: false, closedAt: { gte: today } },
        select: { billPaymentMode: true, tipCents: true },
      }),
      prisma.tableSession.count({
        where: { table: { restaurantId: me.restaurantId }, active: true },
      }),
    ]);

    const byMode = { CARD: 0, CASH: 0, COUNTER: 0 };
    let tipsTotal = 0;
    for (const s of closedToday) {
      if (s.billPaymentMode) byMode[s.billPaymentMode] = (byMode[s.billPaymentMode] ?? 0) + 1;
      tipsTotal += s.tipCents ?? 0;
    }

    return {
      revenueTodayCents: ordersToday._sum.totalCents ?? 0,
      ordersToday: ordersToday._count._all,
      sessionsClosedToday: closedToday.length,
      sessionsActive: activeCount,
      paymentBreakdown: byMode,
      tipsTotal,
    };
  });

  // ── GET /api/caisse/history ────────────────────────────────────────────────
  // Last 30 closed sessions today
  app.get("/history", async (req, reply) => {
    const me = await requireCaisse(req, reply);
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const sessions = await prisma.tableSession.findMany({
      where: { table: { restaurantId: me.restaurantId }, active: false, closedAt: { gte: today } },
      include: {
        table: { select: { number: true } },
        server: { select: { name: true } },
        orders: { where: { status: "PAID" }, select: { totalCents: true } },
      },
      orderBy: { closedAt: "desc" },
      take: 30,
    });

    return { sessions };
  });

  // ── POST /api/caisse/sessions/:id/close ───────────────────────────────────
  // Mark all active orders PAID + close session
  app.post("/sessions/:id/close", async (req, reply) => {
    const me = await requireCaisse(req, reply);
    const { id } = req.params as { id: string };
    const { paymentMode } = z.object({
      paymentMode: z.enum(["CARD", "CASH", "COUNTER"]).default("CARD"),
    }).parse(req.body);

    const session = await prisma.tableSession.findFirst({
      where: { id, table: { restaurantId: me.restaurantId }, active: true },
      include: { orders: { where: { status: { in: ["PENDING", "COOKING", "SERVED"] } } } },
    });
    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });

    await prisma.$transaction([
      // Mark all active orders as PAID
      prisma.order.updateMany({
        where: { sessionId: id, status: { in: ["PENDING", "COOKING", "SERVED"] } },
        data: { status: "PAID" },
      }),
      // Close the session
      prisma.tableSession.update({
        where: { id },
        data: { active: false, closedAt: new Date(), billPaymentMode: paymentMode },
      }),
    ]);

    return { ok: true };
  });
}
