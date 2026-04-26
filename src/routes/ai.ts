/**
 * AI Routes — /api/pro/ia/*
 *
 * Uses Ollama Cloud Models exclusively.
 * Single API key configured globally by admin, used by all PRO_IA restaurants.
 *
 * Ollama Cloud models: gpt-oss:120b, deepseek-v4-flash, qwen3-vl:235b, etc.
 * API: https://ollama.com/api/chat
 * Auth: Bearer token via Authorization header
 *
 * Ollama native format for vision:
 *   messages: [{ role: "user", content: "text prompt", images: ["base64..."] }]
 */
import { requirePro } from "../auth.js";
import { prisma } from "../db.js";
import { getGlobalIaConfig } from "../globalIaConfig.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "crypto";

// ── Ollama Cloud chat completion ──────────────────────────────────────────────
type OllamaMsg = { role: "user" | "assistant" | "system"; content: string; images?: string[] };

// Timeouts — vision can be slow on complex images
const CHAT_TIMEOUT_MS   = 120_000;  // 2min for text
const VISION_TIMEOUT_MS = 240_000;  // 4min for vision
const MAX_RETRIES       = 3;        // retry 429 up to 3 times

async function ollamaCloudChat(
  apiKey: string,
  model: string,
  messages: OllamaMsg[],
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<string> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Exponential backoff: 2s → 4s → 8s before retries
    if (attempt > 0) {
      const delay = Math.min(2000 * 2 ** (attempt - 1), 10_000);
      await new Promise((r) => setTimeout(r, delay));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch("https://ollama.com/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: controller.signal,
      });

      // 429 = too many concurrent requests → wait and retry
      if (res.status === 429) {
        const body = await res.text();
        lastErr = new Error(`ollama error 429: ${body}`);
        continue;
      }

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`ollama error ${res.status}: ${errorText}`);
      }

      const data = await res.json() as any;
      return (data.message?.content ?? "") as string;

    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`ollama timeout after ${timeoutMs / 1000}s — image may be too large or server busy`);
      }
      // Surface 429 errors for retry
      if (err.message?.includes("429")) {
        lastErr = err;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error("ollama: max retries exceeded (429 persists)");
}

/**
 * Streaming variant — sends SSE events to the client while Ollama generates.
 * Keeps the HTTP connection alive so we never hit browser/proxy timeouts.
 *
 * Events:
 *   data: {"type":"chunk","content":"partial text"}
 *   data: {"type":"done","content":"full text"}
 *   data: {"type":"error","message":"..."}
 */
async function ollamaCloudChatStream(
  apiKey: string,
  model: string,
  messages: OllamaMsg[],
  reply: import("fastify").FastifyReply,
  timeoutMs = CHAT_TIMEOUT_MS,
): Promise<string> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = Math.min(2000 * 2 ** (attempt - 1), 10_000);
      await new Promise((r) => setTimeout(r, delay));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch("https://ollama.com/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, messages, stream: true }),
        signal: controller.signal,
      });

      if (res.status === 429) {
        const body = await res.text();
        lastErr = new Error(`ollama error 429: ${body}`);
        continue;
      }

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`ollama error ${res.status}: ${errorText}`);
      }

      // Read the NDJSON stream from Ollama
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body stream");

      const decoder = new TextDecoder();
      let fullContent = "";
      let chunkCount = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        // Ollama streams NDJSON — one JSON object per line
        const lines = text.split("\n").filter(l => l.trim());

        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            const chunk = obj.message?.content ?? "";
            if (chunk) {
              fullContent += chunk;
              chunkCount++;
              // Send progress to client every 5 chunks to avoid flooding
              if (chunkCount % 5 === 0) {
                reply.raw.write(`data: ${JSON.stringify({ type: "chunk", chars: fullContent.length })}\n\n`);
              }
            }
            // If Ollama signals done
            if (obj.done === true) break;
          } catch {
            // Partial JSON line — skip
          }
        }
      }

      clearTimeout(timer);
      return fullContent;

    } catch (err: any) {
      if (err.name === "AbortError") {
        throw new Error(`ollama timeout after ${timeoutMs / 1000}s — image may be too large or server busy`);
      }
      if (err.message?.includes("429")) {
        lastErr = err;
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error("ollama: max retries exceeded (429 persists)");
}

// ── History helper ────────────────────────────────────────────────────────────
async function saveAiHistory(
  restaurantId: string,
  type: string,
  title: string,
  outputData: unknown,
): Promise<void> {
  try {
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AiHistory" (id, "restaurantId", type, title, "outputData", "createdAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
      id,
      restaurantId,
      type,
      title,
      JSON.stringify(outputData),
    );
  } catch {
    // Non-blocking — history errors must never break the main response
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────
export async function aiRoutes(app: FastifyInstance) {
  // Timeout global pour toutes les routes IA (vision = jusqu'à 3min)
  // Also set Fastify reply timeout so the response isn't killed early
  app.addHook("onRequest", async (req, reply) => {
    if (req.url?.includes("/ia/")) {
      (req.socket as any).setTimeout?.(300_000); // 5min socket
      reply.raw.setTimeout?.(300_000);            // 5min HTTP response
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/chat  — chatbot / planning / descriptions
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
      return reply.code(503).send({ error: "IA_KEY_MISSING", message: "Cle API Ollama Cloud non configuree dans l'admin." });
    }

    const { messages } = z.object({
      messages: z.array(z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string(),
      })),
    }).parse(req.body);

    try {
      const text = await ollamaCloudChat(iaConfig.ollamaApiKey, iaConfig.ollamaLangModel, messages);
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
      select: { subscription: true },
    });

    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED", message: "Abonnement PRO_IA requis." });
    }

    const iaConfig = await getGlobalIaConfig();
    if (!iaConfig.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING", message: "Cle API Ollama Cloud non configuree dans l'admin." });
    }

    const { imageBase64 } = z.object({
      imageBase64: z.string(),
      mimeType: z.string().default("image/jpeg"),
    }).parse(req.body);

    const model = iaConfig.ollamaVisionModel;

    // For vision models, merge the system prompt into the user message
    // because some models (qwen3-vl, gemma4) don't support system role with images
    const visionPrompt = `Tu es un expert culinaire. Analyse cette photo de plat et reponds UNIQUEMENT en JSON valide (sans markdown, sans backticks) avec ce format exact :
{"suggestedName":"nom du plat","description":"description 3-4 phrases pour menu","suggestedPrice":"18,00€","allergens":["Gluten"],"diets":["Vegetarien"],"confidence":85}
Allergenes possibles : Gluten, Crustaces, Oeufs, Poisson, Arachides, Soja, Lait, Fruits a coque, Celeri, Moutarde, Sesame, Sulfites, Lupin, Mollusques.
Regimes possibles : Vegetarien, Vegan, Sans gluten, Sans lactose, Halal, Casher.

Analyse ce plat.`;

    const cleanB64 = imageBase64.replace(/^data:[^;]+;base64,/, "");

    try {
      // Single user message with images — no separate system message for vision
      const messages: OllamaMsg[] = [
        { role: "user", content: visionPrompt, images: [cleanB64] },
      ];

      let raw = (await ollamaCloudChat(iaConfig.ollamaApiKey, model, messages, VISION_TIMEOUT_MS))
        .trim().replace(/^```json\n?|```$/g, "").replace(/^```\n?|```$/g, "").trim();

      // Some models wrap JSON in extra text — extract the JSON object
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) raw = jsonMatch[0];

      let result: Record<string, unknown>;
      try { result = JSON.parse(raw); }
      catch { result = { description: raw, confidence: 50 }; }
      return { result };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(502).send({ error: "AI_ERROR", details: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/stock-analysis — Nova Stock IA
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/ia/stock-analysis", async (req, reply) => {
    const me = await requirePro(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true, name: true },
    });
    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED" });
    }

    const iaConfig = await getGlobalIaConfig();
    if (!iaConfig.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING" });
    }

    const body = z.object({
      existingStockNotes: z.string().max(4000).optional(),
      purchaseConstraints: z.string().max(1500).optional(),
      freshProducts: z.string().max(2000).optional(),
      budget: z.number().optional(),
    }).parse(req.body ?? {});

    const menuItems = await prisma.menuItem.findMany({
      where: { restaurantId: me.restaurantId },
      select: { id: true, name: true, priceCents: true, category: true, stockEnabled: true, stockQty: true, lowStockThreshold: true, available: true },
    });

    const twoWeeksAgo = new Date(Date.now() - 14 * 86400_000);
    const recentOrders = await prisma.order.findMany({
      where: { table: { restaurantId: me.restaurantId }, createdAt: { gte: twoWeeksAgo }, status: { not: "CANCELLED" } },
      select: { items: true, createdAt: true, totalCents: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    });

    const salesMap: Record<string, { qty: number; revenue: number; name: string }> = {};
    for (const order of recentOrders) {
      const items = order.items as any[];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const key = item.menuItemId || item.name;
        if (!salesMap[key]) salesMap[key] = { qty: 0, revenue: 0, name: item.name };
        salesMap[key].qty += item.quantity || 1;
        salesMap[key].revenue += (item.priceCents || 0) * (item.quantity || 1);
      }
    }

    const hasTrackedStock = menuItems.some(m => m.stockEnabled);
    const stockContext = body.existingStockNotes?.trim()
      ? body.existingStockNotes.trim()
      : hasTrackedStock
        ? menuItems.filter(m => m.stockEnabled).map(m => `- ${m.name}: ${m.stockQty ?? 0} en stock`).join('\n')
        : 'STOCK VIDE — Le restaurant na declare aucun stock. Considere que tous les ingredients sont a 0. Genere une liste de courses COMPLETE pour la semaine.';

    // Group menu items by category for category-by-category analysis
    const catMap: Record<string, typeof menuItems> = {};
    for (const m of menuItems) {
      const cat = m.category || "Autres";
      (catMap[cat] ||= []).push(m);
    }
    const categoryBreakdown = Object.entries(catMap).map(([cat, items]) =>
      `--- ${cat.toUpperCase()} (${items.length} plats) ---\n` +
      items.map(m => `  - ${m.name} | ${(m.priceCents / 100).toFixed(2)}EUR | ${m.available ? "dispo" : "indispo"}`).join("\n")
    ).join("\n\n");

    const prompt = `Tu es Nova Stock IA, un expert en gestion de stock pour restaurants. Tu dois etre TRES PRECIS et CONCRET.

REGLE ABSOLUE : si le stock est vide ou non declare, "alreadyHave" = 0 et "toBuy" = "estimatedNeeded" pour CHAQUE ingredient. Tu DOIS generer une shoppingList complete, jamais vide.

Restaurant: ${restaurant.name}
Periode d'analyse: 14 derniers jours
Commandes analysees: ${recentOrders.length}
${body.budget ? `Budget courses maximum: ${body.budget}EUR` : 'Pas de budget maximum specifie'}

=== MENU PAR CATEGORIE (${menuItems.length} plats, ${Object.keys(catMap).length} categories) ===
${categoryBreakdown}

=== VENTES 14 JOURS ===
${Object.entries(salesMap).sort((a, b) => b[1].qty - a[1].qty).map(([, v]) => `- ${v.name}: ${v.qty} vendus (${(v.revenue / 100).toFixed(2)}EUR CA)`).join('\n') || 'Aucune vente enregistree — genere tout de meme une liste de courses basee sur le menu'}

=== STOCK ACTUEL ===
${stockContext}

=== PRODUITS FRAIS ===
${body.freshProducts?.trim() || 'Non renseigne'}

=== CONTRAINTES ===
${body.purchaseConstraints?.trim() || 'Aucune contrainte'}

METHODE D'ANALYSE OBLIGATOIRE :
Procede CATEGORIE PAR CATEGORIE. Pour chaque categorie du menu :
1. Liste CHAQUE plat de la categorie
2. Decompose CHAQUE plat en TOUS ses ingredients bruts :
   - Ingredients principaux (viande, poisson, pates, riz...)
   - Bases et alcools (rhum, vodka, gin, tequila, whisky...)
   - Dilutants et mixers (jus d'orange, tonic, soda, ginger beer, eau gazeuse, cola...)
   - Sirops et sucres (sirop de sucre, sirop de grenadine, sirop de menthe, triple sec, creme de mure...)
   - Fruits et garnitures (citron, citron vert, menthe fraiche, ananas, cerise, olives...)
   - Produits laitiers (lait, creme, beurre, fromage, coco...)
   - Condiments et sauces (sel, poivre, huile, vinaigre, moutarde, ketchup...)
   - Consommables (pailles, serviettes, glacons...)
3. Agrege les quantites : un ingredient utilise dans 5 cocktails = 5x la quantite unitaire

ATTENTION SPECIFIQUE aux categories Cocktails / Boissons :
- NE PAS oublier les DILUTANTS (jus, tonic, cola, ginger beer, eau gazeuse, Prosecco)
- NE PAS oublier les SIROPS (grenadine, sucre, menthe, sureau, peche)
- NE PAS oublier les GARNITURES (menthe fraiche, citron, citron vert, ananas, cerise)
- NE PAS oublier les PUREES (passion, cerise, peche)

Reponds UNIQUEMENT en JSON valide (sans markdown, sans commentaire, sans backticks) avec ce format EXACT:
{
  "summary": "Resume en 2-3 phrases — mentionne si stock vide et liste complete generee",
  "alerts": [{"item":"nom","issue":"probleme precis","urgency":"HIGH|MEDIUM|LOW"}],
  "reorderSuggestions": [{"item":"nom","currentStock":0,"suggestedOrder":0,"reason":"courte explication"}],
  "topSellers": [{"item":"nom","qtySold":0,"trend":"UP|STABLE|DOWN"}],
  "deadStock": [{"item":"nom","qtySold":0,"suggestion":"action concrete"}],
  "forecastNextWeek": [{"item":"nom","estimatedDemand":0}],
  "shoppingList": [{"ingredient":"nom ingredient brut","category":"categorie ingredient (Alcools, Dilutants & Mixers, Sirops & Liqueurs, Fruits & Garnitures, Viandes, Poissons, Legumes, Epicerie, Produits laitiers, Consommables)","estimatedNeeded":0,"alreadyHave":0,"toBuy":0,"unit":"kg|L|piece|botte|douzaine|bouteille|cl","priority":"HIGH|MEDIUM|LOW","estimatedCost":0,"reason":"pour quels plats"}],
  "promotions": [{"item":"nom plat","reason":"raison","suggestedDiscount":"-20%","urgency":"HIGH|MEDIUM|LOW","action":"description promo"}],
  "freshProductAlerts": [{"product":"nom","expiresIn":"X jours","qty":"quantite","recommendation":"action","affectedDishes":["plat1"]}],
  "supplierOrderNote": "strategie achat 2-3 phrases",
  "costSavings": "conseil anti-gaspillage concret",
  "totalShoppingBudget": 0
}

Regles OBLIGATOIRES:
1. shoppingList JAMAIS VIDE : deduis les ingredients bruts de TOUS les plats de TOUTES les categories. Si 0 en stock, toBuy = estimatedNeeded complet pour la semaine.
2. MINIMUM 30 ingredients dans la shoppingList pour un menu de plus de 15 plats.
3. Chaque ingredient a un champ "category" pour le regrouper (Alcools, Dilutants & Mixers, Sirops & Liqueurs, Fruits & Garnitures, Viandes, etc.)
4. estimatedCost = prix d'achat reel estime (pas prix de vente).
5. totalShoppingBudget = somme de tous les estimatedCost.
6. Si budget donne et depassable, note-le dans supplierOrderNote.`;

    try {
      let raw = (await ollamaCloudChat(iaConfig.ollamaApiKey, iaConfig.ollamaLangModel, [
        { role: "user", content: prompt },
      ])).trim().replace(/^```json\n?|```$/g, "").replace(/^```\n?|```$/g, "").trim();

      // Extract JSON object from model output
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) raw = jsonMatch[0];

      let analysis: Record<string, unknown>;
      try { analysis = JSON.parse(raw); }
      catch { analysis = { summary: raw, alerts: [], reorderSuggestions: [], topSellers: [], deadStock: [], forecastNextWeek: [], shoppingList: [], promotions: [], freshProductAlerts: [], supplierOrderNote: "", costSavings: "", totalShoppingBudget: 0 }; }

      const meta = { ordersAnalyzed: recentOrders.length, menuItemsCount: menuItems.length, period: "14d", restaurantName: restaurant.name };

      // Auto-save to history
      const shopCount = (analysis.shoppingList as any[])?.length ?? 0;
      const budget = (analysis.totalShoppingBudget as number) ?? 0;
      const title = `Stock ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} — ${shopCount} articles · ~${budget.toFixed(0)}€`;
      await saveAiHistory(me.restaurantId, "STOCK", title, { analysis, meta });

      return { analysis, meta };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(502).send({ error: "AI_ERROR", details: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/stock-items — Étape 1 du wizard stock
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/ia/stock-items", async (req, reply) => {
    const me = await requirePro(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true, name: true },
    });
    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED" });
    }

    const iaConfig = await getGlobalIaConfig();
    if (!iaConfig.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING" });
    }

    const menuItems = await prisma.menuItem.findMany({
      where: { restaurantId: me.restaurantId },
      select: { name: true, priceCents: true, category: true, available: true },
    });

    const twoWeeksAgo = new Date(Date.now() - 14 * 86400_000);
    const recentOrders = await prisma.order.findMany({
      where: { table: { restaurantId: me.restaurantId }, createdAt: { gte: twoWeeksAgo }, status: { not: "CANCELLED" } },
      select: { items: true },
      take: 300,
    });

    const salesMap: Record<string, { qty: number; name: string }> = {};
    for (const order of recentOrders) {
      const items = order.items as any[];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const key = item.menuItemId || item.name;
        if (!salesMap[key]) salesMap[key] = { qty: 0, name: item.name };
        salesMap[key].qty += item.quantity || 1;
      }
    }

    const prompt = `Tu es Nova Stock IA. Analyse ce menu et ces ventes pour identifier les INGREDIENTS BRUTS que ce restaurant doit gérer en stock.

Restaurant: ${restaurant.name}
Menu (${menuItems.length} plats):
${menuItems.map(m => `- ${m.name} (${m.category ?? "autre"})`).join("\n")}

Ventes 14 jours:
${Object.values(salesMap).sort((a,b) => b.qty - a.qty).map(v => `- ${v.name}: ${v.qty} vendus`).join("\n") || "Aucune vente"}

Retourne UNIQUEMENT un JSON valide (sans markdown) avec ce format EXACT:
{
  "items": [
    {
      "name": "Nom ingrédient ou article",
      "unit": "kg|L|piece|botte|douzaine|sachet",
      "category": "Viandes|Poissons|Légumes|Fruits|Produits laitiers|Boissons|Épicerie|Boulangerie|Autres",
      "isFresh": true,
      "linkedDishes": ["plat1", "plat2"],
      "weeklyEstimate": 0
    }
  ]
}

Règles:
- Liste les ingrédients BRUTS nécessaires pour cuisiner le menu, pas les plats finis.
- weeklyEstimate = estimation de la quantité nécessaire par semaine basée sur les ventes.
- isFresh = true si produit périssable (viande, poisson, légumes, laitages, etc.).
- Concentre-toi sur les ingrédients qui représentent un coût significatif ou un risque de rupture.
- Maximum 20 ingrédients les plus importants.`;

    try {
      let raw = (await ollamaCloudChat(iaConfig.ollamaApiKey, iaConfig.ollamaLangModel, [
        { role: "user", content: prompt },
      ])).trim().replace(/^```json\n?|```$/g, "").replace(/^```\n?|```$/g, "").trim();

      // Extract JSON object from model output
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) raw = jsonMatch[0];

      let result: { items: any[] };
      try { result = JSON.parse(raw); }
      catch { return reply.code(502).send({ error: "AI_PARSE_ERROR", raw }); }

      return { items: result.items ?? [], meta: { menuCount: menuItems.length, ordersAnalyzed: recentOrders.length } };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(502).send({ error: "AI_ERROR", details: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/menu-generate — Nova Menu IA
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/ia/menu-generate", async (req, reply) => {
    const me = await requirePro(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true, name: true },
    });
    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED" });
    }

    const iaConfig = await getGlobalIaConfig();
    if (!iaConfig.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING" });
    }

    const body = z.object({
      cuisineType: z.string().max(200).optional(),
      priceRange: z.enum(["budget", "mid", "premium", "gastronomique"]).default("mid"),
      itemCount: z.number().int().min(3).max(50).default(12),
      categories: z.array(z.string()).optional(),
      style: z.string().max(500).optional(),
      imageBase64: z.string().optional(),
    }).parse(req.body);

    if (!body.imageBase64 && !body.cuisineType?.trim()) {
      return reply.code(400).send({ error: "CUISINE_OR_IMAGE_REQUIRED" });
    }

    const catHint = body.categories?.length
      ? `Categories souhaitees: ${body.categories.join(", ")}`
      : "Choisis les categories appropriees (Entrees, Plats, Desserts, Boissons, etc.)";

    const priceGuide: Record<string, string> = {
      budget: "5-12EUR par plat",
      mid: "12-22EUR par plat",
      premium: "22-45EUR par plat",
      gastronomique: "35-80EUR par plat",
    };

    const imageMode = !!body.imageBase64;

    const prompt = imageMode
      ? `Tu es Nova Menu IA, un expert en menus de restaurants.

Restaurant: ${restaurant.name}
${body.cuisineType ? `Cuisine: ${body.cuisineType}` : ""}
Gamme de prix: ${priceGuide[body.priceRange]}
${body.style ? `Style/notes: ${body.style}` : ""}

J'ai pris en photo mon menu actuel (carte, ardoise, ou document).
Analyse cette image et EXTRAIT TOUS les plats visibles. Pour chaque plat:
- Lis le nom exact du plat sur la photo
- Lis le prix s'il est visible, sinon estime un prix coherent pour la gamme ${priceGuide[body.priceRange]}
- Ecris une description vendeuse de 2-3 phrases
- Attribue la bonne categorie (Entrees, Plats, Desserts, Boissons, etc.)
- Identifie les allergenes probables
- Estime un temps de preparation realiste

REPONDS UNIQUEMENT en JSON valide (sans markdown):
{
  "items": [
    {
      "name": "Nom du plat",
      "description": "Description vendeuse 2-3 phrases",
      "priceCents": 1800,
      "category": "Entrees",
      "allergens": ["GLUTEN"],
      "diets": [],
      "waitMinutes": 15
    }
  ]
}

Allergenes possibles: GLUTEN, CRUSTACEANS, EGGS, FISH, PEANUTS, SOYBEANS, MILK, NUTS, CELERY, MUSTARD, SESAME, SULPHITES, LUPIN, MOLLUSCS
Regimes possibles: VEGETARIAN, VEGAN, GLUTEN_FREE, LACTOSE_FREE, HALAL, KOSHER, SPICY
waitMinutes: 0 si pret instantanement (boisson, dessert froid), sinon temps de preparation realiste.
Extrais un maximum de plats de l'image. Sois precis sur les noms et prix visibles.`
      : `Tu es Nova Menu IA, un chef cuisinier expert et designer de menus pour restaurants.

Restaurant: ${restaurant.name}
Cuisine: ${body.cuisineType}
Gamme de prix: ${priceGuide[body.priceRange]}
Nombre de plats: ${body.itemCount}
${catHint}
${body.style ? `Style/notes: ${body.style}` : ""}

Genere un menu complet et REPONDS UNIQUEMENT en JSON valide (sans markdown):
{
  "items": [
    {
      "name": "Nom du plat",
      "description": "Description vendeuse 2-3 phrases",
      "priceCents": 1800,
      "category": "Entrees",
      "allergens": ["GLUTEN"],
      "diets": [],
      "waitMinutes": 15
    }
  ]
}

Allergenes possibles: GLUTEN, CRUSTACEANS, EGGS, FISH, PEANUTS, SOYBEANS, MILK, NUTS, CELERY, MUSTARD, SESAME, SULPHITES, LUPIN, MOLLUSCS
Regimes possibles: VEGETARIAN, VEGAN, GLUTEN_FREE, LACTOSE_FREE, HALAL, KOSHER, SPICY
waitMinutes: 0 si pret instantanement (boisson, dessert froid), sinon temps de preparation realiste.

Sois creatif, les descriptions doivent donner envie. Utilise des ingredients de saison.`;

    try {
      const messages: OllamaMsg[] = [];
      const model = imageMode ? iaConfig.ollamaVisionModel : iaConfig.ollamaLangModel;

      if (imageMode) {
        const cleanB64 = body.imageBase64!.replace(/^data:[^;]+;base64,/, "");
        messages.push({ role: "user", content: prompt, images: [cleanB64] });
      } else {
        messages.push({ role: "user", content: prompt });
      }

      const visionTimeout = imageMode ? VISION_TIMEOUT_MS : CHAT_TIMEOUT_MS;
      let raw = (await ollamaCloudChat(iaConfig.ollamaApiKey, model, messages, visionTimeout))
        .trim().replace(/^```json\n?|```$/g, "").replace(/^```\n?|```$/g, "").trim();

      // Extract JSON object from model output (some models wrap in extra text)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) raw = jsonMatch[0];

      let result: { items: any[] };
      try { result = JSON.parse(raw); }
      catch { return reply.code(502).send({ error: "AI_PARSE_ERROR", raw }); }

      if (!Array.isArray(result.items)) {
        return reply.code(502).send({ error: "AI_PARSE_ERROR", raw });
      }

      const meta = { model, mode: imageMode ? "photo-import" : "generate", cuisineType: body.cuisineType };

      // Auto-save to history
      const title = imageMode
        ? `Import photo — ${result.items.length} plats`
        : `${body.cuisineType ?? "Menu"} — ${result.items.length} plats`;
      await saveAiHistory(me.restaurantId, "MENU", title, { menu: result, meta });

      return { menu: result, meta };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(502).send({ error: "AI_ERROR", details: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/menu-generate/stream — SSE streaming variant (no timeout risk)
  // Sends Server-Sent Events while Ollama generates, keeping HTTP alive.
  // Events: {"type":"progress","phase":"...","chars":N}
  //         {"type":"result","menu":{items:[...]},"meta":{...}}
  //         {"type":"error","message":"..."}
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/ia/menu-generate/stream", async (req, reply) => {
    const me = await requirePro(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true, name: true },
    });
    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED" });
    }

    const iaConfig = await getGlobalIaConfig();
    if (!iaConfig.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING" });
    }

    const body = z.object({
      cuisineType: z.string().max(200).optional(),
      priceRange: z.enum(["budget", "mid", "premium", "gastronomique"]).default("mid"),
      itemCount: z.number().int().min(3).max(50).default(12),
      categories: z.array(z.string()).optional(),
      style: z.string().max(500).optional(),
      imageBase64: z.string().optional(),
    }).parse(req.body);

    if (!body.imageBase64 && !body.cuisineType?.trim()) {
      return reply.code(400).send({ error: "CUISINE_OR_IMAGE_REQUIRED" });
    }

    const catHint = body.categories?.length
      ? `Categories souhaitees: ${body.categories.join(", ")}`
      : "Choisis les categories appropriees (Entrees, Plats, Desserts, Boissons, etc.)";

    const priceGuide: Record<string, string> = {
      budget: "5-12EUR par plat",
      mid: "12-22EUR par plat",
      premium: "22-45EUR par plat",
      gastronomique: "35-80EUR par plat",
    };

    const imageMode = !!body.imageBase64;

    const prompt = imageMode
      ? `Tu es Nova Menu IA, un expert en menus de restaurants.

Restaurant: ${restaurant.name}
${body.cuisineType ? `Cuisine: ${body.cuisineType}` : ""}
Gamme de prix: ${priceGuide[body.priceRange]}
${body.style ? `Style/notes: ${body.style}` : ""}

J'ai pris en photo mon menu actuel (carte, ardoise, ou document).
Analyse cette image et EXTRAIT TOUS les plats visibles. Pour chaque plat:
- Lis le nom exact du plat sur la photo
- Lis le prix s'il est visible, sinon estime un prix coherent pour la gamme ${priceGuide[body.priceRange]}
- Ecris une description vendeuse de 2-3 phrases
- Attribue la bonne categorie (Entrees, Plats, Desserts, Boissons, etc.)
- Identifie les allergenes probables
- Estime un temps de preparation realiste

REPONDS UNIQUEMENT en JSON valide (sans markdown):
{
  "items": [
    {
      "name": "Nom du plat",
      "description": "Description vendeuse 2-3 phrases",
      "priceCents": 1800,
      "category": "Entrees",
      "allergens": ["GLUTEN"],
      "diets": [],
      "waitMinutes": 15
    }
  ]
}

Allergenes possibles: GLUTEN, CRUSTACEANS, EGGS, FISH, PEANUTS, SOYBEANS, MILK, NUTS, CELERY, MUSTARD, SESAME, SULPHITES, LUPIN, MOLLUSCS
Regimes possibles: VEGETARIAN, VEGAN, GLUTEN_FREE, LACTOSE_FREE, HALAL, KOSHER, SPICY
waitMinutes: 0 si pret instantanement (boisson, dessert froid), sinon temps de preparation realiste.
Extrais un maximum de plats de l'image. Sois precis sur les noms et prix visibles.`
      : `Tu es Nova Menu IA, un chef cuisinier expert et designer de menus pour restaurants.

Restaurant: ${restaurant.name}
Cuisine: ${body.cuisineType}
Gamme de prix: ${priceGuide[body.priceRange]}
Nombre de plats: ${body.itemCount}
${catHint}
${body.style ? `Style/notes: ${body.style}` : ""}

Genere un menu complet et REPONDS UNIQUEMENT en JSON valide (sans markdown):
{
  "items": [
    {
      "name": "Nom du plat",
      "description": "Description vendeuse 2-3 phrases",
      "priceCents": 1800,
      "category": "Entrees",
      "allergens": ["GLUTEN"],
      "diets": [],
      "waitMinutes": 15
    }
  ]
}

Allergenes possibles: GLUTEN, CRUSTACEANS, EGGS, FISH, PEANUTS, SOYBEANS, MILK, NUTS, CELERY, MUSTARD, SESAME, SULPHITES, LUPIN, MOLLUSCS
Regimes possibles: VEGETARIAN, VEGAN, GLUTEN_FREE, LACTOSE_FREE, HALAL, KOSHER, SPICY
waitMinutes: 0 si pret instantanement (boisson, dessert froid), sinon temps de preparation realiste.

Sois creatif, les descriptions doivent donner envie. Utilise des ingredients de saison.`;

    // Set up SSE response
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering
    });

    const sendSSE = (data: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const model = imageMode ? iaConfig.ollamaVisionModel : iaConfig.ollamaLangModel;
      const ollamaMessages: OllamaMsg[] = [];

      if (imageMode) {
        const cleanB64 = body.imageBase64!.replace(/^data:[^;]+;base64,/, "");
        ollamaMessages.push({ role: "user", content: prompt, images: [cleanB64] });
      } else {
        ollamaMessages.push({ role: "user", content: prompt });
      }

      sendSSE({ type: "progress", phase: "sending", message: "Envoi au serveur IA..." });

      // Use streaming variant to keep connection alive
      const timeoutMs = imageMode ? VISION_TIMEOUT_MS : CHAT_TIMEOUT_MS;
      const raw = await ollamaCloudChatStream(iaConfig.ollamaApiKey, model, ollamaMessages, reply, timeoutMs);

      sendSSE({ type: "progress", phase: "parsing", message: "Extraction des plats..." });

      // Clean and parse JSON
      let cleaned = raw.trim().replace(/^```json\n?|```$/g, "").replace(/^```\n?|```$/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (jsonMatch) cleaned = jsonMatch[0];

      let result: { items: any[] };
      try { result = JSON.parse(cleaned); }
      catch {
        sendSSE({ type: "error", message: "L'IA n'a pas retourné un JSON valide. Réessayez." });
        reply.raw.end();
        return;
      }

      if (!Array.isArray(result.items)) {
        sendSSE({ type: "error", message: "Format de réponse IA invalide." });
        reply.raw.end();
        return;
      }

      const meta = { model, mode: imageMode ? "photo-import" : "generate", cuisineType: body.cuisineType };

      // Auto-save to history
      const title = imageMode
        ? `Import photo — ${result.items.length} plats`
        : `${body.cuisineType ?? "Menu"} — ${result.items.length} plats`;
      await saveAiHistory(me.restaurantId, "MENU", title, { menu: result, meta });

      // Send final result
      sendSSE({ type: "result", menu: result, meta });
    } catch (err: any) {
      app.log.error(err);
      sendSSE({ type: "error", message: err.message || "Erreur serveur IA" });
    } finally {
      reply.raw.end();
    }

    // Prevent Fastify from trying to send a response (we already wrote to raw)
    return reply;
  });

  // POST /ia/menu-generate/apply — bulk-create items from generated menu
  app.post("/ia/menu-generate/apply", async (req, reply) => {
    const me = await requirePro(req, reply);

    const { items } = z.object({
      items: z.array(z.object({
        name: z.string(),
        description: z.string().optional(),
        priceCents: z.number().int().min(0),
        category: z.string().optional(),
        allergens: z.array(z.string()).optional(),
        diets: z.array(z.string()).optional(),
        waitMinutes: z.number().int().min(0).max(180).optional(),
      })).min(1).max(50),
    }).parse(req.body);

    const created = [];
    for (const item of items) {
      const { waitMinutes, ...prismaData } = item;
      const mi = await prisma.menuItem.create({
        data: {
          ...prismaData,
          allergens: (prismaData.allergens ?? []) as any,
          diets: (prismaData.diets ?? []) as any,
          restaurantId: me.restaurantId,
        } as any,
      });
      if (waitMinutes && waitMinutes > 0) {
        await prisma.$executeRaw`UPDATE "MenuItem" SET "waitMinutes" = ${waitMinutes} WHERE id = ${mi.id}`;
      }
      created.push(mi);
    }

    return { ok: true, count: created.length, items: created };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/financial-advice — Conseiller Financier IA
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/ia/financial-advice", async (req, reply) => {
    const me = await requirePro(req, reply);

    const restaurant = await prisma.restaurant.findUnique({
      where: { id: me.restaurantId },
      select: { subscription: true, name: true },
    });
    if (!restaurant || restaurant.subscription !== "PRO_IA") {
      return reply.code(403).send({ error: "IA_NOT_SUBSCRIBED" });
    }

    const iaConfig = await getGlobalIaConfig();
    if (!iaConfig.ollamaApiKey) {
      return reply.code(503).send({ error: "IA_KEY_MISSING" });
    }

    const body = z.object({
      period: z.enum(["7d", "30d", "90d"]).default("30d"),
      fixedCosts: z.number().optional(),        // charges fixes mensuelle (loyer, salaires…)
      foodCostTarget: z.number().optional(),    // food cost cible % (ex: 30)
      notes: z.string().max(1000).optional(),   // notes libres (événements, saisonnalité…)
    }).parse(req.body ?? {});

    const periodDays = body.period === "90d" ? 90 : body.period === "7d" ? 7 : 30;
    const since = new Date(Date.now() - periodDays * 86400_000);

    const menuItems = await prisma.menuItem.findMany({
      where: { restaurantId: me.restaurantId },
      select: { name: true, priceCents: true, category: true, available: true },
    });

    const orders = await prisma.order.findMany({
      where: { table: { restaurantId: me.restaurantId }, createdAt: { gte: since }, status: { not: "CANCELLED" } },
      select: { items: true, totalCents: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 1000,
    });

    // Aggregate revenue by day
    const revenueByDay: Record<string, number> = {};
    let totalRevenue = 0;
    for (const o of orders) {
      const day = o.createdAt.toISOString().slice(0, 10);
      revenueByDay[day] = (revenueByDay[day] ?? 0) + (o.totalCents ?? 0);
      totalRevenue += o.totalCents ?? 0;
    }

    // Sales map
    const salesMap: Record<string, { qty: number; revenue: number; name: string }> = {};
    for (const o of orders) {
      const items = o.items as any[];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const key = item.menuItemId || item.name;
        if (!salesMap[key]) salesMap[key] = { qty: 0, revenue: 0, name: item.name };
        salesMap[key].qty += item.quantity || 1;
        salesMap[key].revenue += (item.priceCents || 0) * (item.quantity || 1);
      }
    }

    const topByRevenue = Object.values(salesMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 15)
      .map(v => `- ${v.name}: ${v.qty} vendus · ${(v.revenue / 100).toFixed(2)}€ CA`);

    const dailySummary = Object.entries(revenueByDay)
      .slice(-14)
      .map(([d, c]) => `${d}: ${(c / 100).toFixed(2)}€`)
      .join("\n");

    const prompt = `Tu es Nova Finance IA, conseiller financier expert pour restaurants. Tu analyses les données réelles du restaurant et fournis des recommandations concrètes et actionnables.

Restaurant: ${restaurant.name}
Période analysée: ${periodDays} derniers jours
Commandes: ${orders.length}
CA total période: ${(totalRevenue / 100).toFixed(2)}€
CA moyen / jour: ${orders.length > 0 ? ((totalRevenue / 100) / periodDays).toFixed(2) : "0"}€
CA moyen / commande: ${orders.length > 0 ? ((totalRevenue / 100) / orders.length).toFixed(2) : "0"}€
${body.fixedCosts ? `Charges fixes déclarées: ${body.fixedCosts}€/mois` : "Charges fixes: non renseignées"}
${body.foodCostTarget ? `Objectif food cost: ${body.foodCostTarget}%` : ""}
${body.notes ? `Notes: ${body.notes}` : ""}

=== CHIFFRE D'AFFAIRES (14 derniers jours) ===
${dailySummary || "Aucune donnée"}

=== TOP PLATS PAR CA ===
${topByRevenue.join("\n") || "Aucune vente"}

=== MENU (${menuItems.length} plats) ===
${menuItems.map(m => `- ${m.name} | ${(m.priceCents / 100).toFixed(2)}€ | ${m.category ?? "sans catégorie"} | ${m.available ? "dispo" : "indispo"}`).join("\n")}

Réponds UNIQUEMENT en JSON valide (sans markdown) avec ce format EXACT:
{
  "kpis": {
    "totalRevenue": 0,
    "avgRevenuePerDay": 0,
    "avgTicket": 0,
    "projectedMonthly": 0,
    "projectedAnnual": 0,
    "estimatedFoodCost": 0,
    "estimatedMargin": 0,
    "marginPercent": 0
  },
  "weeklyTrend": [{"week":"Semaine 1","revenue":0,"orders":0}],
  "topDishes": [{"name":"nom","revenue":0,"qty":0,"revenueShare":0}],
  "underperformers": [{"name":"nom","revenue":0,"qty":0,"issue":"raison","action":"recommandation"}],
  "recommendations": [
    {"type":"PRICING|MENU|MARKETING|COSTS|FORECAST","title":"titre","detail":"explication concrète 2-3 phrases","impact":"HIGH|MEDIUM|LOW","effort":"EASY|MEDIUM|HARD"}
  ],
  "forecast": {
    "nextWeekRevenue": 0,
    "nextMonthRevenue": 0,
    "confidence": 70,
    "risks": ["risque 1"],
    "opportunities": ["opportunité 1"]
  },
  "offersProposed": [
    {"dish":"nom plat","type":"HAPPY_HOUR|COMBO|PROMO_SEMAINE|FORMULE","description":"description de l'offre","discountPercent":15,"estimatedRevenueBoost":"% ou €","rationale":"pourquoi cette offre"}
  ],
  "summary": "Résumé exécutif en 3-4 phrases avec les chiffres clés et l'action prioritaire."
}

Règles:
- Sois précis avec les chiffres réels fournis.
- projectedMonthly = extrapolation sur 30j basée sur le CA/jour réel.
- estimatedFoodCost = estimation % basée sur les prix de vente (hypothèse 28-35% pour un restaurant français standard).
- offersProposed = 2-4 offres concrètes basées sur les données réelles (plats sous-performants, heures creuses, etc.)
- weeklyTrend = agrège les données en semaines.`;

    try {
      let raw = (await ollamaCloudChat(iaConfig.ollamaApiKey, iaConfig.ollamaLangModel, [
        { role: "user", content: prompt },
      ])).trim().replace(/^```json\n?|```$/g, "").replace(/^```\n?|```$/g, "").trim();

      // Extract JSON object from model output
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) raw = jsonMatch[0];

      let advice: Record<string, unknown>;
      try { advice = JSON.parse(raw); }
      catch {
        advice = { summary: raw, kpis: {}, recommendations: [], forecast: {}, offersProposed: [], topDishes: [], underperformers: [], weeklyTrend: [] };
      }

      const meta = { ordersAnalyzed: orders.length, totalRevenueCents: totalRevenue, period: body.period, restaurantName: restaurant.name };

      const ca = (totalRevenue / 100).toFixed(0);
      const title = `Finance ${new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "short" })} — ${periodDays}j · ${ca}€ CA`;
      await saveAiHistory(me.restaurantId, "FINANCE", title, { advice, meta });

      return { advice, meta };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(502).send({ error: "AI_ERROR", details: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET  /ia/history?type=STOCK|MENU|CHAT|PLANNING|FINANCE  — list IA history
  // POST /ia/history                                 — save from frontend (chat/planning)
  // DELETE /ia/history/:id                           — delete one entry
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/ia/history", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { type } = (req.query as any) ?? {};

    let rows: any[];
    if (type) {
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, type, title, "outputData", "createdAt"
         FROM "AiHistory"
         WHERE "restaurantId" = $1 AND type = $2
         ORDER BY "createdAt" DESC
         LIMIT 30`,
        me.restaurantId,
        type,
      );
    } else {
      rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT id, type, title, "outputData", "createdAt"
         FROM "AiHistory"
         WHERE "restaurantId" = $1
         ORDER BY "createdAt" DESC
         LIMIT 60`,
        me.restaurantId,
      );
    }

    return { history: rows };
  });

  app.post("/ia/history", async (req, reply) => {
    const me = await requirePro(req, reply);

    const { type, title, outputData } = z.object({
      type: z.enum(["CHAT", "PLANNING", "STOCK", "MENU", "FINANCE"]),
      title: z.string().max(200),
      outputData: z.any(),
    }).parse(req.body);

    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "AiHistory" (id, "restaurantId", type, title, "outputData", "createdAt")
       VALUES ($1, $2, $3, $4, $5::jsonb, NOW())`,
      id,
      me.restaurantId,
      type,
      title,
      JSON.stringify(outputData),
    );

    return { ok: true, id };
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/offers/deploy — deploy an offer proposed by Nova Finance
  // GET  /ia/offers        — list active offers
  // DELETE /ia/offers/:id  — remove an active offer
  // ─────────────────────────────────────────────────────────────────────────────
  app.post("/ia/offers/deploy", async (req, reply) => {
    const me = await requirePro(req, reply);

    const body = z.object({
      dish: z.string(),
      type: z.string(),
      description: z.string(),
      discountPercent: z.number(),
      rationale: z.string().optional(),
      endsAt: z.string().optional(), // ISO date string, default 7 days from now
    }).parse(req.body);

    const id = randomUUID();
    const endsAt = body.endsAt ? new Date(body.endsAt) : new Date(Date.now() + 7 * 86400_000);

    await prisma.$executeRawUnsafe(
      `INSERT INTO "ActiveOffer" (id, "restaurantId", dish, type, description, "discountPercent", rationale, "endsAt", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
      id, me.restaurantId, body.dish, body.type, body.description, body.discountPercent, body.rationale ?? "", endsAt,
    );

    return { ok: true, id, endsAt };
  });

  app.get("/ia/offers", async (req, reply) => {
    const me = await requirePro(req, reply);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, dish, type, description, "discountPercent", rationale, "endsAt", "createdAt"
       FROM "ActiveOffer"
       WHERE "restaurantId" = $1 AND "endsAt" > NOW()
       ORDER BY "createdAt" DESC`,
      me.restaurantId,
    );

    return { offers: rows };
  });

  app.delete("/ia/offers/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };

    await prisma.$executeRawUnsafe(
      `DELETE FROM "ActiveOffer" WHERE id = $1 AND "restaurantId" = $2`,
      id, me.restaurantId,
    );

    return { ok: true };
  });

  app.delete("/ia/history/:id", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { id } = req.params as { id: string };

    await prisma.$executeRawUnsafe(
      `DELETE FROM "AiHistory" WHERE id = $1 AND "restaurantId" = $2`,
      id,
      me.restaurantId,
    );

    return { ok: true };
  });
}
