/**
 * AI Routes — /api/pro/ia/*
 *
 * Supports multiple cloud providers:
 *   - OpenAI    : gpt-4o, gpt-4o-mini, gpt-4-turbo, o1-mini
 *   - Anthropic : claude-3-5-sonnet-*, claude-3-haiku-*, claude-3-opus-*
 *   - Google    : gemini-1.5-pro, gemini-1.5-flash, gemini-2.0-flash
 *   - Mistral   : mistral-large-latest, mistral-small-latest, codestral-latest
 *
 * The provider is auto-detected from the model name prefix.
 * The `ollamaApiKey` field stores the provider's API key.
 */
import { requirePro } from "../auth.js";
import { prisma } from "../db.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

// ── Provider detection ────────────────────────────────────────────────────────
type Provider = "openai" | "anthropic" | "google" | "mistral";

function detectProvider(model: string): Provider {
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("mistral") || model.startsWith("codestral")) return "mistral";
  return "openai";
}

// ── Unified chat completion ───────────────────────────────────────────────────
type Msg = { role: "user" | "assistant" | "system"; content: string | any[] };

async function cloudChat(
  provider: Provider,
  apiKey: string,
  model: string,
  messages: Msg[]
): Promise<string> {
  if (provider === "openai" || provider === "mistral") {
    const base = provider === "openai"
      ? "https://api.openai.com/v1"
      : "https://api.mistral.ai/v1";
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, max_tokens: 1024 }),
    });
    if (!res.ok) throw new Error(`${provider} error ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    return data.choices[0].message.content;
  }

  if (provider === "anthropic") {
    const system = messages.find(m => m.role === "system")?.content as string | undefined;
    const filtered = messages.filter(m => m.role !== "system");
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        ...(system ? { system } : {}),
        messages: filtered,
      }),
    });
    if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    return data.content[0].text;
  }

  if (provider === "google") {
    const contents = messages
      .filter(m => m.role !== "system")
      .map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: Array.isArray(m.content)
          ? m.content
          : [{ text: m.content as string }],
      }));
    const systemInstruction = messages.find(m => m.role === "system")?.content;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
          generationConfig: { maxOutputTokens: 1024 },
        }),
      }
    );
    if (!res.ok) throw new Error(`Google error ${res.status}: ${await res.text()}`);
    const data = await res.json() as any;
    return data.candidates[0].content.parts[0].text;
  }

  throw new Error("Unknown provider");
}

// ── Vision helper — build provider-specific image message ─────────────────────
function buildVisionMessages(
  provider: Provider,
  systemPrompt: string,
  imageBase64: string,
  mimeType: string
): Msg[] {
  if (provider === "openai" || provider === "mistral") {
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
  if (provider === "anthropic") {
    return [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } },
          { type: "text", text: "Analyse ce plat." },
        ],
      },
    ];
  }
  if (provider === "google") {
    return [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { inlineData: { mimeType, data: imageBase64 } },
          { text: "Analyse ce plat." },
        ] as any,
      },
    ];
  }
  return [];
}

export async function aiRoutes(app: FastifyInstance) {
  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/chat  — chatbot / planning / descriptions
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/ia/chat", async (req, reply) => {
    const me = await requirePro(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true, ollamaApiKey: true, ollamaLangModel: true },
    });

    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED", message: "Abonnement PRO_IA requis." });
    }
    if (!restaurant.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING", message: "Clé API non configurée. Ajoutez-la dans l'admin." });
    }

    const { messages } = z.object({
      messages: z.array(z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string(),
      })),
    }).parse(req.body);

    const model = restaurant.ollamaLangModel ?? "gpt-4o-mini";
    const provider = detectProvider(model);

    try {
      const text = await cloudChat(provider, restaurant.ollamaApiKey, model, messages);
      return { message: { role: "assistant", content: text } };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(502).send({ error: "AI_ERROR", details: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/magic-scan  — vision / photo plat → JSON menu
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/ia/magic-scan", async (req, reply) => {
    const me = await requirePro(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true, ollamaApiKey: true, ollamaVisionModel: true, ollamaLangModel: true },
    });

    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED", message: "Abonnement PRO_IA requis." });
    }
    if (!restaurant.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING", message: "Clé API non configurée." });
    }

    const { imageBase64, mimeType } = z.object({
      imageBase64: z.string(),
      mimeType: z.string().default("image/jpeg"),
    }).parse(req.body);

    // Vision model (fallback to lang model if same provider supports vision)
    const model = restaurant.ollamaVisionModel ?? restaurant.ollamaLangModel ?? "gpt-4o";
    const provider = detectProvider(model);

    const systemPrompt = `Tu es un expert culinaire. Analyse cette photo de plat et réponds UNIQUEMENT en JSON valide (sans markdown) avec ce format exact :
{"suggestedName":"nom du plat","description":"description 3-4 phrases pour menu","suggestedPrice":"18,00€","allergens":["Gluten"],"diets":["Végétarien"],"confidence":85}
Allergènes possibles : Gluten, Crustacés, Oeufs, Poisson, Arachides, Soja, Lait, Fruits à coque, Céleri, Moutarde, Sésame, Sulfites, Lupin, Mollusques.
Régimes possibles : Végétarien, Vegan, Sans gluten, Sans lactose, Halal, Casher.`;

    try {
      const messages = buildVisionMessages(provider, systemPrompt, imageBase64, mimeType);
      const raw = (await cloudChat(provider, restaurant.ollamaApiKey, model, messages))
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
