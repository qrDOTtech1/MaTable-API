/**
 * AI Routes — /api/pro/ia/*
 *
 * Uses Ollama Cloud Models exclusively.
 * Single API key configured globally by admin, used by all PRO_IA restaurants.
 *
 * Ollama Cloud models: gpt-oss:120b-cloud, gpt-4o-cloud, llama3.1:latest-cloud, etc.
 * API: https://ollama.com/api/chat (OpenAI-compatible format)
 * Auth: Bearer token via Authorization header
 */
import { requirePro } from "../auth.js";
import { prisma } from "../db.js";
import { getGlobalIaConfig } from "../globalIaConfig.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

// ── Ollama Cloud chat completion ──────────────────────────────────────────────
type Msg = { role: "user" | "assistant" | "system"; content: string | any[] };

async function ollamaCloudChat(
  apiKey: string,
  model: string,
  messages: Msg[]
): Promise<string> {
  const res = await fetch("https://ollama.com/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`ollama error ${res.status}: ${errorText}`);
  }

  const data = await res.json() as any;
  return data.choices[0].message.content;
}

// ── Vision helper — build Ollama Cloud vision message ──────────────────────────
function buildVisionMessages(
  systemPrompt: string,
  imageBase64: string,
  mimeType: string
): Msg[] {
  return [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: [
        { type: "text", text: "Analyse ce plat." },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
      ],
    },
  ];
}

export async function aiRoutes(app: FastifyInstance) {
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/chat  — chatbot / planning / descriptions (Ollama Cloud)
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/ia/chat", async (req, reply) => {
    const me = await requirePro(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true },
    });

    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED", message: "Abonnement PRO_IA requis." });
    }

    const iaConfig = await getGlobalIaConfig();
    if (!iaConfig.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING", message: "Clé API Ollama Cloud non configurée dans l'admin." });
    }

    const { messages } = z.object({
      messages: z.array(z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string(),
      })),
    }).parse(req.body);

    const model = iaConfig.ollamaLangModel;

    try {
      const text = await ollamaCloudChat(iaConfig.ollamaApiKey, model, messages);
      return { message: { role: "assistant", content: text } };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(502).send({ error: "AI_ERROR", details: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/magic-scan  — vision / photo plat → JSON menu (Ollama Cloud)
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/ia/magic-scan", async (req, reply) => {
    const me = await requirePro(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true },
    });

    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED", message: "Abonnement PRO_IA requis." });
    }

    const iaConfig = await getGlobalIaConfig();
    if (!iaConfig.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING", message: "Clé API Ollama Cloud non configurée dans l'admin." });
    }

    const { imageBase64, mimeType } = z.object({
      imageBase64: z.string(),
      mimeType: z.string().default("image/jpeg"),
    }).parse(req.body);

    const model = iaConfig.ollamaVisionModel;

    const systemPrompt = `Tu es un expert culinaire. Analyse cette photo de plat et réponds UNIQUEMENT en JSON valide (sans markdown) avec ce format exact :
{"suggestedName":"nom du plat","description":"description 3-4 phrases pour menu","suggestedPrice":"18,00€","allergens":["Gluten"],"diets":["Végétarien"],"confidence":85}
Allergènes possibles : Gluten, Crustacés, Oeufs, Poisson, Arachides, Soja, Lait, Fruits à coque, Céleri, Moutarde, Sésame, Sulfites, Lupin, Mollusques.
Régimes possibles : Végétarien, Vegan, Sans gluten, Sans lactose, Halal, Casher.`;

    try {
      const messages = buildVisionMessages(systemPrompt, imageBase64, mimeType);
      const raw = (await ollamaCloudChat(iaConfig.ollamaApiKey, model, messages))
        .trim().replace(/^```json\n?|```$/g, "");

      let result: Record<string, unknown>;
      try { result = JSON.parse(raw); }
      catch { result = { description: raw, confidence: 50 }; }
      return { result };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(502).send({ error: "AI_ERROR", details: err.message });
    }
  });
}
