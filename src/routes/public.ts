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

export async function publicRoutes(app: FastifyInstance) {
  /* ── Contact Form from Landing Page ── */
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

    reply.header("Content-Type", media.mimeType);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(Buffer.from(media.bytes as any));
  });

  app.get("/photo/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const photo = await prisma.photo.findUnique({ where: { id } });
    if (!photo) return reply.code(404).send({ error: "not_found" });
    reply.header("Content-Type", photo.mimeType);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(Buffer.from(photo.bytes as any));
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
          photos: (restaurant as any).photos
            ?.filter((p: any) => p.menuItemId === m.id)
            .map((p: any) => ({ id: p.id, url: `/api/photo/${p.id}` })) ?? [],
        })),
        openingHours: restaurant.openingHours,
        photos: (restaurant as any).photos
          ?.filter((p: any) => !p.menuItemId)
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
    const { date } = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().split("T")[0]),
    }).parse(req.query ?? {});

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      include: { openingHours: true },
    });
    if (!restaurant) return reply.code(404).send({ error: "restaurant_not_found" });
    if (!(restaurant as any).acceptReservations) return { slots: [] };

    const d = new Date(date + "T12:00:00"); // noon to avoid TZ issues
    const dayOfWeek = d.getDay(); // 0=Sunday

    const dayHours = restaurant.openingHours.filter((h) => h.dayOfWeek === dayOfWeek);
    if (!dayHours.length) return { slots: [] };

    const slotMin: number = (restaurant as any).reservationSlotMinutes ?? 30;
    const leadMin: number = (restaurant as any).reservationLeadMinutes ?? 60;
    const mealMin: number = (restaurant as any).avgPrepMinutes ?? 90;

    const now = new Date();
    const slots: { date: string; time: string; available: boolean }[] = [];

    for (const period of dayHours) {
      let cur: number = period.openMin;
      const lastSlot = period.closeMin - mealMin;
      while (cur <= lastSlot) {
        const slotDate = new Date(date + "T00:00:00");
        slotDate.setHours(Math.floor(cur / 60), cur % 60, 0, 0);
        const time = `${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`;
        const available = slotDate.getTime() > now.getTime() + leadMin * 60_000;
        slots.push({ date, time, available });
        cur += slotMin;
      }
    }

    return { slots };
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
      select: { id: true, name: true, reviewsEnabled: true },
    });
    
    if (!r) return reply.code(404).send({ error: "NOT_FOUND" });
    if (!r.reviewsEnabled) return reply.code(403).send({ error: "REVIEWS_DISABLED" });

    // Get specific configuration fields via raw query because they are not in prisma schema yet
    const configRaw = await prisma.$queryRawUnsafe<any[]>(
      `SELECT "googleReviewLink", "reviewVoucherConfig" FROM "Restaurant" WHERE id = $1`, r.id
    );
    const googleReviewLink = configRaw[0]?.googleReviewLink || null;
    const reviewVoucherConfig = configRaw[0]?.reviewVoucherConfig || null;

    // Get list of active servers with their photos
    const servers = await prisma.server.findMany({
      where: { restaurantId: r.id, active: true },
      select: { id: true, name: true, photoUrl: true }
    });

    return {
      restaurant: { id: r.id, name: r.name },
      googleReviewLink,
      reviewVoucherConfig,
      servers
    };
  });

  // ---------------------------------------------------------------------------
  // POST /api/ia/review-chat — Chat conversationnel IA pour récolter des avis
  // ---------------------------------------------------------------------------
  app.post("/ia/review-chat", async (req, reply) => {
    const body = z.object({
      restaurantId: z.string().min(1),
      serverName: z.string().min(1),
      ratings: z.object({
        food: z.number(),
        service: z.number(),
        atmosphere: z.number(),
        value: z.number()
      }),
      history: z.array(z.object({
        role: z.enum(["ai", "user"]),
        content: z.string()
      }))
    }).parse(req.body);

    const { send, close } = setupSSE(reply);

    try {
      const iaConfig = await getGlobalIaConfig();
      if (!iaConfig.ollamaApiKey) throw new Error("No API Key configured globally");

      const isFinalTurn = body.history.filter(m => m.role === "user").length >= 2;

      let prompt = `Tu es l'assistant virtuel parfait d'un restaurant, chargé de récolter les avis clients de manière chaleureuse.
Notes du client (sur 5) : Cuisine: ${body.ratings.food}, Service: ${body.ratings.service}, Ambiance: ${body.ratings.atmosphere}, Qualité/Prix: ${body.ratings.value}.
Serveur: ${body.serverName}.

`;
      if (body.history.length > 0) {
        prompt += "Historique:\n";
        body.history.forEach(m => {
          prompt += `${m.role === 'ai' ? 'Toi' : 'Client'}: ${m.content}\n`;
        });
      }

      if (isFinalTurn) {
        prompt += `
INSTRUCTION : Le client a répondu à tes questions. Tu dois maintenant GÉNÉRER L'AVIS GOOGLE FINAL.
L'avis doit être naturel, mentionner le prénom du serveur, et refléter les notes et les réponses du client.
Ne renvoie STRICTEMENT rien d'autre que ce JSON (pas de bloc markdown) :
{
  "version1": "Texte court de l'avis 1",
  "version2": "Texte court de l'avis 2"
}`;
      } else {
        prompt += `
INSTRUCTION : Pose UNE SEULE question ciblée et très courte (maximum 15 mots) sur un aspect précis du repas, en fonction des notes données. N'utilise pas de politesse excessive. 
Propose ensuite exactement 3 suggestions de réponses courtes séparées par le caractère " | ".
Format attendu STRICTEMENT :
<Ta question> | <Choix 1> | <Choix 2> | <Choix 3>

Exemple:
La cuisson de votre viande était-elle à votre goût ? | Parfaite | Un peu trop cuite | Saignante à souhait`;
      }

      const fullOutput = await ollamaCloudChatStream(
        iaConfig.ollamaApiKey,
        iaConfig.ollamaLangModel || "llama3.3",
        [{ role: "user", content: prompt }],
        (chunk) => { send({ type: "chunk", text: chunk }); },
      );

      if (isFinalTurn) {
        try {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "CustomerReview" (id, "restaurantId", "serverName", ratings, "reviewText", "chatHistory", "createdAt") VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, NOW())`,
            randomUUID(), body.restaurantId, body.serverName, JSON.stringify(body.ratings), fullOutput, JSON.stringify(body.history)
          );
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
      select: { id: true, name: true },
    });
    if (!restaurant) return reply.code(404).send({ error: "restaurant_not_found" });

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
    }).parse(req.body);

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, name: true, address: true, phone: true },
    });
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

    const reservation = await prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        startsAt,
        partySize: input.guests,
        customerName: input.name,
        customerEmail: input.email ?? "",
        customerPhone: input.phone,
        status: "PENDING",
      },
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

    return { ok: true, reservationId: reservation.id };
  });

  app.post("/orders", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const body = z
      .object({
        items: z
          .array(z.object({ menuItemId: z.string(), quantity: z.number().int().min(1) }))
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
    const lines = body.items.map((i) => {
      const m = byId.get(i.menuItemId);
      if (!m) throw reply.code(400).send({ error: "unknown_item" });
      return { menuItemId: m.id, name: m.name, quantity: i.quantity, priceCents: m.priceCents };
    });
    const totalCents = lines.reduce((s, l) => s + l.priceCents * l.quantity, 0);

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
