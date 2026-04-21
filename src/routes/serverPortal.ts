/**
 * Server Portal Routes — /api/server/*
 *
 * Authentication: servers log in with their 4-digit PIN via:
 *   POST /api/server/login  { slug, pin }
 * The response contains a short-lived server JWT (8h).
 * All other routes require this token in Authorization: Bearer <token>.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { env } from "../env.js";
import jwt from "jsonwebtoken";

type ServerJwtPayload = { serverId: string; restaurantId: string };

function signServerToken(payload: ServerJwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "8h" });
}

async function requireServer(req: any, reply: any): Promise<ServerJwtPayload> {
  const auth = req.headers?.authorization as string | undefined;
  if (!auth?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "UNAUTHORIZED" });
    throw new Error("Unauthorized");
  }
  try {
    return jwt.verify(auth.slice(7), env.JWT_SECRET) as ServerJwtPayload;
  } catch {
    reply.code(401).send({ error: "INVALID_TOKEN" });
    throw new Error("Invalid token");
  }
}

export async function serverPortalRoutes(app: FastifyInstance) {
  // ── POST /api/server/login ─────────────────────────────────────────────────
  app.post("/login", async (req, reply) => {
    const { slug, pin } = z.object({
      slug: z.string(),
      pin: z.string().min(4).max(6),
    }).parse(req.body);

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, name: true, subscription: true },
    });
    if (!restaurant) return reply.code(404).send({ error: "RESTAURANT_NOT_FOUND" });

    const server = await prisma.server.findFirst({
      where: { restaurantId: restaurant.id, pin, active: true },
    });
    if (!server) return reply.code(401).send({ error: "INVALID_PIN" });

    const token = signServerToken({ serverId: server.id, restaurantId: restaurant.id });
    return {
      token,
      server: { id: server.id, name: server.name, photoUrl: server.photoUrl },
      restaurant: { id: restaurant.id, name: restaurant.name, subscription: restaurant.subscription },
    };
  });

  // ── GET /api/server/me ─────────────────────────────────────────────────────
  app.get("/me", async (req, reply) => {
    const me = await requireServer(req, reply);
    const server = await prisma.server.findUnique({
      where: { id: me.serverId },
      include: {
        schedules: { orderBy: [{ dayOfWeek: "asc" }] },
        notes: { orderBy: { updatedAt: "desc" }, take: 20 },
        challenges: { orderBy: { createdAt: "desc" } },
      },
    });
    if (!server) return reply.code(404).send({ error: "NOT_FOUND" });

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { name: true, subscription: true },
    });

    return { server, restaurant };
  });

  // ── GET /api/server/tables ─────────────────────────────────────────────────
  // Returns tables assigned to this server (active sessions) + all orders
  app.get("/tables", async (req, reply) => {
    const me = await requireServer(req, reply);

    const sessions = await prisma.tableSession.findMany({
      where: { serverId: me.serverId, active: true },
      include: {
        table: true,
        orders: {
          where: { status: { in: ["PENDING", "COOKING", "SERVED"] } },
          orderBy: { createdAt: "desc" },
        },
      },
    });

    // Also get all active tables for context
    const allTables = await prisma.table.findMany({
      where: { restaurantId: me.restaurantId },
      include: {
        sessions: {
          where: { active: true },
          take: 1,
          include: { server: { select: { id: true, name: true } } },
        },
      },
      orderBy: { number: "asc" },
    });

    return { sessions, allTables };
  });

  // ── GET /api/server/stats ──────────────────────────────────────────────────
  app.get("/stats", async (req, reply) => {
    const me = await requireServer(req, reply);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [ordersToday, reviews, tips] = await Promise.all([
      prisma.order.count({
        where: { serverId: me.serverId, createdAt: { gte: today } },
      }),
      prisma.serverReview.aggregate({
        where: { serverId: me.serverId },
        _avg: { rating: true },
        _count: { _all: true },
      }),
      prisma.tableSession.aggregate({
        where: { serverId: me.serverId, active: false, closedAt: { gte: today } },
        _sum: { tipCents: true },
      }),
    ]);

    return {
      ordersToday,
      avgRating: reviews._avg.rating,
      totalReviews: reviews._count._all,
      tipsToday: tips._sum.tipCents ?? 0,
    };
  });

  // ── Notes CRUD ─────────────────────────────────────────────────────────────
  app.post("/notes", async (req, reply) => {
    const me = await requireServer(req, reply);
    const { content } = z.object({ content: z.string().min(1).max(2000) }).parse(req.body);
    const note = await prisma.serverNote.create({
      data: { serverId: me.serverId, content },
    });
    return { note };
  });

  app.patch("/notes/:id", async (req, reply) => {
    const me = await requireServer(req, reply);
    const { id } = req.params as { id: string };
    const { content } = z.object({ content: z.string().min(1).max(2000) }).parse(req.body);
    const note = await prisma.serverNote.updateMany({
      where: { id, serverId: me.serverId },
      data: { content },
    });
    return { note };
  });

  app.delete("/notes/:id", async (req, reply) => {
    const me = await requireServer(req, reply);
    const { id } = req.params as { id: string };
    await prisma.serverNote.deleteMany({ where: { id, serverId: me.serverId } });
    return { ok: true };
  });

  // ── Challenges CRUD ────────────────────────────────────────────────────────
  app.post("/challenges", async (req, reply) => {
    const me = await requireServer(req, reply);
    const body = z.object({
      title: z.string().min(1).max(200),
      dueDate: z.string().optional(),
    }).parse(req.body);
    const challenge = await prisma.serverChallenge.create({
      data: {
        serverId: me.serverId,
        title: body.title,
        dueDate: body.dueDate ? new Date(body.dueDate) : null,
      },
    });
    return { challenge };
  });

  app.patch("/challenges/:id/toggle", async (req, reply) => {
    const me = await requireServer(req, reply);
    const { id } = req.params as { id: string };
    const existing = await prisma.serverChallenge.findFirst({ where: { id, serverId: me.serverId } });
    if (!existing) return reply.code(404).send({ error: "NOT_FOUND" });
    const updated = await prisma.serverChallenge.update({
      where: { id },
      data: { done: !existing.done },
    });
    return { challenge: updated };
  });

  app.delete("/challenges/:id", async (req, reply) => {
    const me = await requireServer(req, reply);
    const { id } = req.params as { id: string };
    await prisma.serverChallenge.deleteMany({ where: { id, serverId: me.serverId } });
    return { ok: true };
  });

  // ── IA Planning Suggestion (PRO_IA only) ──────────────────────────────────
  app.post("/ia/planning-suggest", async (req, reply) => {
    const me = await requireServer(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true, ollamaApiKey: true, ollamaLangModel: true },
    });

    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED" });
    }
    if (!restaurant.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING" });
    }

    const { context, currentPlanning } = z.object({
      context: z.string().max(500),
      currentPlanning: z.string().max(2000).optional(),
    }).parse(req.body);

    const model = restaurant.ollamaLangModel ?? "gpt-oss:120b";

    const server = await prisma.server.findUnique({
      where: { id: me.serverId },
      select: { name: true },
    });

    const prompt = `Tu es un assistant pour un serveur en restaurant nommé ${server?.name ?? "serveur"}.
Voici le contexte/retour client du serveur : "${context}"
${currentPlanning ? `Planning actuel : ${currentPlanning}` : ""}
Génère 2-3 suggestions concrètes d'amélioration du planning ou des plats du jour basées sur ce retour terrain.
Réponds de façon concise en français, en bullet points.`;

    try {
      const response = await fetch("https://ollama.com/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${restaurant.ollamaApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: "Tu es un assistant restauration. Réponds en français, de façon concise et actionnable." },
            { role: "user", content: prompt },
          ],
          stream: false,
        }),
      });

      if (!response.ok) {
        return reply.code(502).send({ error: "OLLAMA_ERROR" });
      }

      const data = await response.json() as { message: { content: string } };
      return { suggestions: data.message.content };
    } catch (err: any) {
      return reply.code(500).send({ error: "AI_SERVICE_UNAVAILABLE" });
    }
  });
}
