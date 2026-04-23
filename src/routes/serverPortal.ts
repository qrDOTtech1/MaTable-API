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
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

    const [server, restaurant, globalChallenges] = await Promise.all([
      prisma.server.findUnique({
        where: { id: me.serverId },
        include: {
          schedules: { orderBy: [{ dayOfWeek: "asc" }] },
          notes: { orderBy: { updatedAt: "desc" }, take: 20 },
          challenges: {
            where: { isGlobal: false },
            orderBy: { createdAt: "desc" },
          },
        },
      }),
      prisma.restaurant.findUnique({
        where: { id: me.restaurantId },
        select: { name: true, subscription: true },
      }),
      // Global AI challenges generated today for this restaurant
      prisma.serverChallenge.findMany({
        where: {
          serverId: me.serverId,
          isGlobal: true,
          createdAt: { gte: today, lt: tomorrow },
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);

    if (!server) return reply.code(404).send({ error: "NOT_FOUND" });
    return { server: { ...server, globalChallenges }, restaurant };
  });

  // ── GET /api/server/tables ─────────────────────────────────────────────────
  // Returns:
  //   sessions    → ALL active sessions of the restaurant (not just mine)
  //                 Sessions assigned to me come first, unassigned second.
  //                 This way servers see orders even when no serverId is set.
  //   allTables   → All tables with their active session state
  //   myEmptyTables → Tables assigned to me with no active session
  app.get("/tables", async (req, reply) => {
    const me = await requireServer(req, reply);

    // All active sessions for the entire restaurant — sorted: mine first, then unassigned, then others
    const allSessions = await prisma.tableSession.findMany({
      where: { table: { restaurantId: me.restaurantId }, active: true },
      include: {
        table: { select: { id: true, number: true, seats: true } },
        orders: {
          where: { status: { in: ["PENDING", "COOKING", "SERVED"] } },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Sort: mine first, unassigned second, others last
    const sessions = allSessions.sort((a, b) => {
      const aMine = a.serverId === me.serverId ? 0 : a.serverId === null ? 1 : 2;
      const bMine = b.serverId === me.serverId ? 0 : b.serverId === null ? 1 : 2;
      return aMine - bMine;
    });

    // All tables of the restaurant with session state
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

    // My assigned empty tables (no active session yet but table is mine by default)
    const activeSessionTableIds = new Set(sessions.map((s) => s.tableId));
    const myEmptyTables = allTables.filter(
      (t) => (t as any).assignedServerId === me.serverId && !activeSessionTableIds.has(t.id)
    );

    return { sessions, allTables, myEmptyTables };
  });

  // ── POST /api/server/tables/:sessionId/claim ──────────────────────────────
  // Server claims an unassigned (or reassignable) session
  app.post("/tables/:sessionId/claim", async (req, reply) => {
    const me = await requireServer(req, reply);
    const { sessionId } = req.params as { sessionId: string };

    const session = await prisma.tableSession.findFirst({
      where: { id: sessionId, table: { restaurantId: me.restaurantId }, active: true },
    });
    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });

    const updated = await prisma.tableSession.update({
      where: { id: sessionId },
      data: { serverId: me.serverId },
    });
    return { ok: true, session: updated };
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

  // ── AI Daily Challenges — generate for all servers (PRO_IA only) ──────────
  // Generates 3 competitive cross-server challenges once per day
  app.post("/challenges/generate-daily", async (req, reply) => {
    const me = await requireServer(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { name: true, subscription: true, ollamaApiKey: true, ollamaLangModel: true },
    });

    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED" });
    }

    // Check if already generated today
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
    const existing = await prisma.serverChallenge.findFirst({
      where: { restaurantId: me.restaurantId, isGlobal: true, createdAt: { gte: today, lt: tomorrow } },
    });
    if (existing) {
      // Already generated — just return today's challenges for this server
      const challenges = await prisma.serverChallenge.findMany({
        where: { serverId: me.serverId, isGlobal: true, createdAt: { gte: today, lt: tomorrow } },
      });
      return { challenges, alreadyGenerated: true };
    }

    // Get all active servers
    const servers = await prisma.server.findMany({
      where: { restaurantId: me.restaurantId, active: true },
      select: { id: true, name: true },
    });

    // Generate challenges via AI
    let challengeTitles: string[] = [];
    if (restaurant.ollamaApiKey) {
      try {
        const today_label = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
        const prompt = `Tu es un chef de salle qui organise des défis quotidiens entre serveurs pour maintenir la motivation.
Aujourd'hui c'est ${today_label} au restaurant "${restaurant.name}".
Génère exactement 3 défis de service compétitifs, originaux et mesurables pour la journée.
Les défis doivent être amusants, stimulants, réalisables en service et créer de la saine compétition.
Format: retourne UNIQUEMENT 3 lignes, une par défi, sans numérotation, sans explication.
Exemples: "Proposer un dessert à chaque table et en vendre au moins 3", "Obtenir 2 compliments spontanés clients notés", "Mémoriser et réciter la composition de 5 plats sans carte"`;

        const response = await fetch("https://ollama.com/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${restaurant.ollamaApiKey}` },
          body: JSON.stringify({
            model: restaurant.ollamaLangModel ?? "gpt-oss:120b",
            messages: [
              { role: "system", content: "Tu génères des défis de restaurant. Réponds en français avec exactement 3 lignes." },
              { role: "user", content: prompt },
            ],
            stream: false,
          }),
        });
        if (response.ok) {
          const data = await response.json() as { message: { content: string } };
          challengeTitles = data.message.content
            .split("\n")
            .map((l: string) => l.trim().replace(/^[-•*]\s*/, ""))
            .filter((l: string) => l.length > 5)
            .slice(0, 3);
        }
      } catch {}
    }

    // Fallback challenges if AI unavailable
    if (challengeTitles.length < 3) {
      const fallbacks = [
        "Proposer un dessert à chaque table — vendre au moins 3 desserts",
        "Obtenir 2 compliments spontanés de clients",
        "Mémoriser et réciter la composition de 5 plats sans consulter la carte",
      ];
      while (challengeTitles.length < 3) challengeTitles.push(fallbacks[challengeTitles.length]);
    }

    // Create one challenge per server per title
    const dueDate = tomorrow;
    const createData = servers.flatMap((server) =>
      challengeTitles.map((title) => ({
        id: require("crypto").randomUUID(),
        serverId: server.id,
        title,
        isGlobal: true,
        restaurantId: me.restaurantId,
        dueDate,
        done: false,
        createdAt: new Date(),
      }))
    );
    await prisma.serverChallenge.createMany({ data: createData });

    // Return this server's challenges
    const myChallenges = createData.filter((c) => c.serverId === me.serverId);
    return { challenges: myChallenges, alreadyGenerated: false };
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
