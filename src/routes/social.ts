import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { emitToSession } from "../realtime.js";

// Note: Direct session emission needs a way to find the session.
// In our current setup, we emit to rooms.

export async function socialRoutes(app: FastifyInstance) {
  
  // ─── Profile Management ───────────────────────────────────────────────────
  
  app.post("/social/profile", async (req, reply) => {
    const data = z.object({
      externalId: z.string().optional(),
      name: z.string().min(1),
      image: z.string().url().optional(),
      email: z.string().email().optional(),
      bio: z.string().optional(),
      interests: z.array(z.string()).optional(),
      occupation: z.string().optional(),
      activeMode: z.enum(["BUSINESS", "FUN", "DATE", "HIDDEN"]).default("HIDDEN"),
      restaurantId: z.string().uuid().optional(),
      sessionId: z.string().uuid().optional(),
    }).parse(req.body);

    let profile;
    if (data.externalId) {
      profile = await prisma.socialProfile.upsert({
        where: { externalId: data.externalId },
        update: {
          name: data.name,
          image: data.image,
          bio: data.bio,
          interests: data.interests,
          occupation: data.occupation,
          activeMode: data.activeMode,
          currentRestaurantId: data.restaurantId,
        },
        create: {
          externalId: data.externalId,
          name: data.name,
          image: data.image,
          email: data.email,
          bio: data.bio,
          interests: data.interests || [],
          occupation: data.occupation,
          activeMode: data.activeMode,
          currentRestaurantId: data.restaurantId,
        },
      });
    } else {
      profile = await prisma.socialProfile.create({
        data: {
          name: data.name,
          image: data.image,
          bio: data.bio,
          interests: data.interests || [],
          occupation: data.occupation,
          activeMode: data.activeMode,
          currentRestaurantId: data.restaurantId,
        },
      });
    }

    if (data.sessionId) {
      await prisma.tableSession.update({
        where: { id: data.sessionId },
        data: { socialProfileId: profile.id },
      });
    }

    return { profile };
  });

  app.get("/social/nearby/:restaurantId", async (req, reply) => {
    const { restaurantId } = req.params as { restaurantId: string };
    const { mode } = req.query as { mode?: string };

    const nearby = await prisma.socialProfile.findMany({
      where: {
        currentRestaurantId: restaurantId,
        activeMode: mode ? (mode as any) : { not: "HIDDEN" },
      },
      select: {
        id: true,
        name: true,
        image: true,
        occupation: true,
        interests: true,
        activeMode: true,
        bio: true,
      }
    });

    return { nearby };
  });

  // ─── Pings & Interactions ──────────────────────────────────────────────────

  app.post("/social/ping", async (req, reply) => {
    const { senderId, receiverId, message, mode } = z.object({
      senderId: z.string().uuid(),
      receiverId: z.string().uuid(),
      message: z.string().optional(),
      mode: z.enum(["BUSINESS", "FUN", "DATE"]),
    }).parse(req.body);

    const ping = await prisma.socialPing.create({
      data: { senderId, receiverId, message, mode },
      include: { sender: true },
    });

    // Notify receiver via socket if they have an active session
    const receiverSessions = await prisma.tableSession.findMany({
      where: { socialProfileId: receiverId, active: true },
    });

    for (const session of receiverSessions) {
      emitToSession(session.id, "social:ping", {
        id: ping.id,
        senderName: ping.sender.name,
        senderImage: ping.sender.image,
        message: ping.message,
        mode: ping.mode,
      });
    }

    return { ok: true, pingId: ping.id };
  });

  // ─── IA Matching Suggestions ──────────────────────────────────────────────

  app.get("/social/match/:profileId", async (req, reply) => {
    const { profileId } = req.params as { profileId: string };
    const me = await prisma.socialProfile.findUnique({ where: { id: profileId } });
    if (!me || !me.currentRestaurantId) return reply.code(404).send({ error: "profile_not_active" });

    const others = await prisma.socialProfile.findMany({
      where: {
        currentRestaurantId: me.currentRestaurantId,
        id: { not: me.id },
        activeMode: me.activeMode,
      },
    });

    if (others.length === 0) return { matches: [] };

    // Here we would call Ollama to analyze interests and suggest the best match
    // For now, let's just return them with a fake score
    const matches = others.map(o => ({
      ...o,
      matchScore: Math.floor(Math.random() * 40) + 60, // Fake score
      icebreaker: `Hey ${o.name}, j'ai vu que tu aimais ${o.interests[0] || "la gastronomie"} !`,
    }));

    return { matches: matches.sort((a, b) => b.matchScore - a.matchScore) };
  });
}
