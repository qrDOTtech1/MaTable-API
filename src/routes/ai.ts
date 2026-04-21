import { requirePro } from "../auth.js";
import { prisma } from "../db.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const OLLAMA_CLOUD_BASE = "https://ollama.com/api";

function ollamaHeaders(apiKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

export async function aiRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /ia/chat  — language model (Chatbot, Planning IA, Descriptions IA)
  // ---------------------------------------------------------------------------
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
      return reply.code(503).send({ error: "IA_KEY_MISSING", message: "Clé API Ollama non configurée. Contactez votre administrateur." });
    }

    const { messages } = z.object({
      messages: z.array(z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string(),
      })),
    }).parse(req.body);

    const model = restaurant.ollamaLangModel ?? "gpt-oss:120b";

    try {
      const response = await fetch(`${OLLAMA_CLOUD_BASE}/chat`, {
        method: "POST",
        headers: ollamaHeaders(restaurant.ollamaApiKey),
        body: JSON.stringify({ model, messages, stream: false }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        app.log.error(`Ollama chat error ${response.status}: ${text}`);
        return reply.code(502).send({ error: "OLLAMA_ERROR", details: text });
      }

      const data = await response.json() as { message: { role: string; content: string } };
      return { message: data.message };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(500).send({ error: "AI_SERVICE_UNAVAILABLE", details: err.message });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /ia/magic-scan  — vision model (analyse photo de plat)
  // ---------------------------------------------------------------------------
  app.post("/ia/magic-scan", async (req, reply) => {
    const me = await requirePro(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true, ollamaApiKey: true, ollamaVisionModel: true },
    });

    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED", message: "Abonnement PRO_IA requis." });
    }
    if (!restaurant.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING", message: "Clé API Ollama non configurée." });
    }

    const { imageBase64, mimeType } = z.object({
      imageBase64: z.string(),
      mimeType: z.string().default("image/jpeg"),
    }).parse(req.body);

    const model = restaurant.ollamaVisionModel ?? "llama3.2-vision:11b";

    const systemPrompt = `Tu es un expert culinaire. Analyse cette photo de plat et réponds UNIQUEMENT en JSON valide (sans markdown) avec ce format exact :
{"suggestedName":"nom du plat","description":"description 3-4 phrases pour menu","suggestedPrice":"18,00€","allergens":["Gluten"],"diets":["Végétarien"],"confidence":85}
Allergènes possibles : Gluten, Crustacés, Oeufs, Poisson, Arachides, Soja, Lait, Fruits à coque, Céleri, Moutarde, Sésame, Sulfites, Lupin, Mollusques.
Régimes possibles : Végétarien, Vegan, Sans gluten, Sans lactose, Halal, Casher.`;

    try {
      const response = await fetch(`${OLLAMA_CLOUD_BASE}/chat`, {
        method: "POST",
        headers: ollamaHeaders(restaurant.ollamaApiKey),
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                { type: "text", text: "Analyse ce plat." },
                { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
              ],
            },
          ],
          stream: false,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => response.statusText);
        return reply.code(502).send({ error: "OLLAMA_ERROR", details: text });
      }

      const data = await response.json() as { message: { content: string } };
      const raw = data.message.content.trim().replace(/^```json\n?|```$/g, "");
      let result: Record<string, unknown>;
      try {
        result = JSON.parse(raw);
      } catch {
        result = { description: raw, confidence: 50 };
      }
      return { result };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(500).send({ error: "AI_SERVICE_UNAVAILABLE", details: err.message });
    }
  });
}
