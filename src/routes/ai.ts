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

// ── Ollama Cloud chat completion ──────────────────────────────────────────────
type OllamaMsg = { role: "user" | "assistant" | "system"; content: string; images?: string[] };

async function ollamaCloudChat(
  apiKey: string,
  model: string,
  messages: OllamaMsg[]
): Promise<string> {
  const res = await fetch("https://ollama.com/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`ollama error ${res.status}: ${errorText}`);
  }

  const data = await res.json() as any;
  return (data.message?.content ?? "") as string;
}

export async function aiRoutes(app: FastifyInstance) {
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
  // Ollama native: images are passed as base64 strings in `images` array
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
      mimeType: z.string().default("image/jpeg"), // kept for compat but unused by Ollama
    }).parse(req.body);

    const model = iaConfig.ollamaVisionModel;

    const systemPrompt = `Tu es un expert culinaire. Analyse cette photo de plat et reponds UNIQUEMENT en JSON valide (sans markdown) avec ce format exact :
{"suggestedName":"nom du plat","description":"description 3-4 phrases pour menu","suggestedPrice":"18,00€","allergens":["Gluten"],"diets":["Vegetarien"],"confidence":85}
Allergenes possibles : Gluten, Crustaces, Oeufs, Poisson, Arachides, Soja, Lait, Fruits a coque, Celeri, Moutarde, Sesame, Sulfites, Lupin, Mollusques.
Regimes possibles : Vegetarien, Vegan, Sans gluten, Sans lactose, Halal, Casher.`;

    // Strip data URI prefix if present (e.g. "data:image/jpeg;base64,...")
    const cleanB64 = imageBase64.replace(/^data:[^;]+;base64,/, "");

    try {
      // Ollama native vision format: images array on the user message
      const messages: OllamaMsg[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: "Analyse ce plat.", images: [cleanB64] },
      ];

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

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/stock-analysis — Nova Stock IA
  // Analyses order history + current stock → recommendations
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
      freshProducts: z.string().max(2000).optional(), // produits frais avec dates d'expiration
      budget: z.number().optional(), // budget maximum pour les courses
    }).parse(req.body ?? {});

    // Gather data: menu items with stock + recent orders (last 14 days)
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

    // Build sales summary per item
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

    // Si aucun article ne suivi en stock → tout est à 0
    const hasTrackedStock = menuItems.some(m => m.stockEnabled);
    const stockContext = body.existingStockNotes?.trim()
      ? body.existingStockNotes.trim()
      : hasTrackedStock
        ? menuItems.filter(m => m.stockEnabled).map(m => `- ${m.name}: ${m.stockQty ?? 0} en stock`).join('\n')
        : 'STOCK VIDE — Le restaurant na declare aucun stock. Considere que tous les ingredients sont a 0. Genere une liste de courses COMPLETE pour la semaine.';

    const prompt = `Tu es Nova Stock IA, un expert en gestion de stock pour restaurants. Tu dois etre TRES PRECIS et CONCRET.

REGLE ABSOLUE : si le stock est vide ou non declare, "alreadyHave" = 0 et "toBuy" = "estimatedNeeded" pour CHAQUE ingredient. Tu DOIS generer une shoppingList complete, jamais vide.

Restaurant: ${restaurant.name}
Periode d'analyse: 14 derniers jours
Commandes analysees: ${recentOrders.length}
${body.budget ? `Budget courses maximum: ${body.budget}EUR` : 'Pas de budget maximum specifie'}

=== MENU (${menuItems.length} plats) ===
${menuItems.map(m => `- ${m.name} | ${(m.priceCents/100).toFixed(2)}EUR | Dispo: ${m.available ? 'oui' : 'non'}`).join('\n')}

=== VENTES 14 JOURS ===
${Object.entries(salesMap).sort((a,b) => b[1].qty - a[1].qty).map(([,v]) => `- ${v.name}: ${v.qty} vendus (${(v.revenue/100).toFixed(2)}EUR CA)`).join('\n') || 'Aucune vente enregistree — genere tout de meme une liste de courses basee sur le menu'}

=== STOCK ACTUEL ===
${stockContext}

=== PRODUITS FRAIS ===
${body.freshProducts?.trim() || 'Non renseigne'}

=== CONTRAINTES ===
${body.purchaseConstraints?.trim() || 'Aucune contrainte'}

Reponds UNIQUEMENT en JSON valide (sans markdown, sans commentaire) avec ce format EXACT:
{
  "summary": "Resume en 2-3 phrases — mentionne si stock vide et liste complete generee",
  "alerts": [{"item":"nom","issue":"probleme precis","urgency":"HIGH|MEDIUM|LOW"}],
  "reorderSuggestions": [{"item":"nom","currentStock":0,"suggestedOrder":0,"reason":"courte explication"}],
  "topSellers": [{"item":"nom","qtySold":0,"trend":"UP|STABLE|DOWN"}],
  "deadStock": [{"item":"nom","qtySold":0,"suggestion":"action concrete"}],
  "forecastNextWeek": [{"item":"nom","estimatedDemand":0}],
  "shoppingList": [{"ingredient":"nom ingredient brut","estimatedNeeded":0,"alreadyHave":0,"toBuy":0,"unit":"kg|L|piece|botte|douzaine","priority":"HIGH|MEDIUM|LOW","estimatedCost":0,"reason":"pour quels plats"}],
  "promotions": [{"item":"nom plat","reason":"raison","suggestedDiscount":"-20%","urgency":"HIGH|MEDIUM|LOW","action":"description promo"}],
  "freshProductAlerts": [{"product":"nom","expiresIn":"X jours","qty":"quantite","recommendation":"action","affectedDishes":["plat1"]}],
  "supplierOrderNote": "strategie achat 2-3 phrases",
  "costSavings": "conseil anti-gaspillage concret",
  "totalShoppingBudget": 0
}

Regles OBLIGATOIRES:
1. shoppingList JAMAIS VIDE : deduis les ingredients bruts de TOUS les plats du menu. Si 0 en stock, toBuy = estimatedNeeded complet pour la semaine.
   Ex: menu avec entrecote → "Boeuf (entrecotes)": estimatedNeeded=8kg, alreadyHave=0, toBuy=8kg
   Ex: menu avec saumon → "Saumon frais": estimatedNeeded=4kg, alreadyHave=0, toBuy=4kg
2. Couvre TOUS les plats du menu, pas seulement les mieux vendus.
3. estimatedCost = prix d'achat reel estime (pas prix de vente).
4. totalShoppingBudget = somme de tous les estimatedCost.
5. Si budget donne et depassable, note-le dans supplierOrderNote.`;

    try {
      const raw = (await ollamaCloudChat(iaConfig.ollamaApiKey, iaConfig.ollamaLangModel, [
        { role: "user", content: prompt },
      ])).trim().replace(/^```json\n?|```$/g, "").replace(/^```\n?|```$/g, "");

      let analysis: Record<string, unknown>;
      try { analysis = JSON.parse(raw); }
      catch { analysis = { summary: raw, alerts: [], reorderSuggestions: [], topSellers: [], deadStock: [], forecastNextWeek: [], shoppingList: [], promotions: [], freshProductAlerts: [], supplierOrderNote: "", costSavings: "", totalShoppingBudget: 0 }; }

      return { analysis, meta: { ordersAnalyzed: recentOrders.length, menuItemsCount: menuItems.length, period: "14d", restaurantName: restaurant.name } };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(502).send({ error: "AI_ERROR", details: err.message });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // POST /ia/stock-items — Étape 1 du wizard stock
  // L'IA analyse le menu + ventes et retourne la liste des articles
  // qu'elle veut suivre, avec l'unité et la quantité suggérée à commander
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

    // Récupère le menu et les ventes 14 jours
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
      const raw = (await ollamaCloudChat(iaConfig.ollamaApiKey, iaConfig.ollamaLangModel, [
        { role: "user", content: prompt },
      ])).trim().replace(/^```json\n?|```$/g, "").replace(/^```\n?|```$/g, "");

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
  // Generates a full menu from a description or photo
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
      imageBase64: z.string().optional(), // optional photo of existing menu/carte
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

      const raw = (await ollamaCloudChat(iaConfig.ollamaApiKey, model, messages))
        .trim().replace(/^```json\n?|```$/g, "").replace(/^```\n?|```$/g, "");

      let result: { items: any[] };
      try { result = JSON.parse(raw); }
      catch { return reply.code(502).send({ error: "AI_PARSE_ERROR", raw }); }

      if (!Array.isArray(result.items)) {
        return reply.code(502).send({ error: "AI_PARSE_ERROR", raw });
      }

      return { menu: result, meta: { model, mode: imageMode ? "photo-import" : "generate" } };
    } catch (err: any) {
      app.log.error(err);
      return reply.code(502).send({ error: "AI_ERROR", details: err.message });
    }
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
}
