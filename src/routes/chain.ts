import type { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { prisma } from "../db.js";
import { requireChain } from "../auth.js";

// ── Inline migration — run once per process startup ──────────────────────────
let migrationDone = false;
async function ensureChainSchema() {
  if (migrationDone) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Chain" (
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        "logoUrl" TEXT,
        "adminEmail" TEXT NOT NULL,
        "adminPasswordHash" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "Chain_pkey" PRIMARY KEY (id)
      )
    `);
    await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "Chain_adminEmail_key" ON "Chain"("adminEmail")`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "chainId" TEXT`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "mapLat" DOUBLE PRECISION`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "mapLng" DOUBLE PRECISION`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "mapLabel" TEXT`);
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "Restaurant_chainId_idx" ON "Restaurant"("chainId")`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "businessType" TEXT NOT NULL DEFAULT 'RESTAURANT'`);
    await prisma.$executeRawUnsafe(`ALTER TABLE "Restaurant" ADD COLUMN IF NOT EXISTS "reviewCustomQuestions" TEXT`);
    migrationDone = true;
  } catch (err: any) {
    console.error("[chain] ensureChainSchema error:", err.message);
  }
}

export async function chainRoutes(app: FastifyInstance) {
  // Run migration on every request until confirmed done
  app.addHook("preHandler", async () => { await ensureChainSchema(); });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/chain/register — créer un compte chaîne
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/register", async (req, reply) => {
    const body = z.object({
      name:          z.string().min(2).max(100),
      adminEmail:    z.string().email(),
      adminPassword: z.string().min(8),
    }).parse(req.body);

    const existing = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM "Chain" WHERE "adminEmail" = $1`, body.adminEmail
    );
    if (existing.length > 0) return reply.code(409).send({ error: "email_taken" });

    const hash = await bcrypt.hash(body.adminPassword, 10);
    const id = randomUUID();
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Chain" (id, name, "adminEmail", "adminPasswordHash") VALUES ($1, $2, $3, $4)`,
      id, body.name, body.adminEmail, hash
    );

    const token = app.jwt.sign({ kind: "chain", chainId: id }, { expiresIn: "7d" });
    return { token, chain: { id, name: body.name, logoUrl: null } };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/chain/login
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/login", async (req, reply) => {
    const { adminEmail, adminPassword } = z.object({
      adminEmail:    z.string().email(),
      adminPassword: z.string().min(1),
    }).parse(req.body);

    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, name, "logoUrl", "adminPasswordHash" FROM "Chain" WHERE "adminEmail" = $1`,
      adminEmail
    );
    if (rows.length === 0) return reply.code(401).send({ error: "invalid_credentials" });
    const chain = rows[0];

    const valid = await bcrypt.compare(adminPassword, chain.adminPasswordHash);
    if (!valid) return reply.code(401).send({ error: "invalid_credentials" });

    const token = app.jwt.sign(
      { kind: "chain", chainId: chain.id },
      { expiresIn: "7d" }
    );
    return { token, chain: { id: chain.id, name: chain.name, logoUrl: chain.logoUrl } };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /api/chain/me — infos chaîne + liste des établissements avec stats
  // ─────────────────────────────────────────────────────────────────────────
  app.get("/me", async (req, reply) => {
    const { chainId } = await requireChain(req, reply);

    const chains = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, name, "logoUrl" FROM "Chain" WHERE id = $1`, chainId
    );
    if (chains.length === 0) return reply.code(404).send({ error: "chain_not_found" });

    const restaurants = await prisma.$queryRawUnsafe<any[]>(
      `SELECT
         r.id, r.name, r.slug, r.city, r.address, r."businessType",
         r."mapLat", r."mapLng", r."mapLabel",
         COALESCE((
           SELECT COUNT(*)::int FROM "Order" o
           JOIN "TableSession" ts ON ts.id = o."sessionId"
           JOIN "Table" t ON t.id = ts."tableId"
           WHERE t."restaurantId" = r.id AND o.status = 'PAID'
         ), 0) AS "totalOrders",
         COALESCE((
           SELECT SUM(o."totalCents") FROM "Order" o
           JOIN "TableSession" ts ON ts.id = o."sessionId"
           JOIN "Table" t ON t.id = ts."tableId"
           WHERE t."restaurantId" = r.id AND o.status = 'PAID'
         ), 0) AS "totalRevenueCents",
         COALESCE((
           SELECT ROUND(AVG(
             ((cr.ratings->>'food')::float +
              (cr.ratings->>'service')::float +
              (cr.ratings->>'atmosphere')::float +
              (cr.ratings->>'value')::float) / 4.0
           )::numeric, 1)
           FROM "CustomerReview" cr WHERE cr."restaurantId" = r.id
         ), 0) AS "avgRating",
         COALESCE((
           SELECT COUNT(*)::int FROM "Order" o
           JOIN "TableSession" ts ON ts.id = o."sessionId"
           JOIN "Table" t ON t.id = ts."tableId"
           WHERE t."restaurantId" = r.id
             AND o.status = 'PAID'
             AND o."createdAt" >= NOW() - INTERVAL '24 hours'
         ), 0) AS "ordersToday"
       FROM "Restaurant" r
       WHERE r."chainId" = $1
       ORDER BY r.name ASC`,
      chainId
    );

    const mapped = restaurants.map((r: any) => ({
      ...r,
      totalOrders:       Number(r.totalOrders),
      totalRevenueCents: Number(r.totalRevenueCents),
      avgRating:         Number(r.avgRating),
      ordersToday:       Number(r.ordersToday),
    }));

    const totalRevenueCents = mapped.reduce((s, r) => s + r.totalRevenueCents, 0);
    const totalOrders       = mapped.reduce((s, r) => s + r.totalOrders, 0);
    const rated = mapped.filter(r => r.avgRating > 0);
    const avgRating = rated.length
      ? Math.round(rated.reduce((s, r) => s + r.avgRating, 0) / rated.length * 10) / 10
      : 0;

    return {
      chain: chains[0],
      restaurants: mapped,
      stats: {
        totalEstablishments: mapped.length,
        totalRevenueCents,
        totalOrders,
        avgRating,
      },
    };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /api/chain/restaurants/:restaurantId/map-position — sauvegarder pin
  // ─────────────────────────────────────────────────────────────────────────
  app.patch("/restaurants/:restaurantId/map-position", async (req, reply) => {
    const { chainId } = await requireChain(req, reply);
    const { restaurantId } = req.params as { restaurantId: string };
    const { lat, lng, label } = z.object({
      lat:   z.number().min(-90).max(90),
      lng:   z.number().min(-180).max(180),
      label: z.string().max(100).optional(),
    }).parse(req.body);

    const check = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM "Restaurant" WHERE id = $1 AND "chainId" = $2`, restaurantId, chainId
    );
    if (check.length === 0) return reply.code(403).send({ error: "not_in_chain" });

    await prisma.$executeRawUnsafe(
      `UPDATE "Restaurant" SET "mapLat" = $1, "mapLng" = $2, "mapLabel" = $3 WHERE id = $4`,
      lat, lng, label ?? null, restaurantId
    );
    return { ok: true };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/chain/restaurants/:restaurantId/impersonate
  // Renvoie un token pro temporaire (8h) pour accéder au dashboard d'un établissement
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/restaurants/:restaurantId/impersonate", async (req, reply) => {
    const { chainId } = await requireChain(req, reply);
    const { restaurantId } = req.params as { restaurantId: string };

    const check = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM "Restaurant" WHERE id = $1 AND "chainId" = $2`, restaurantId, chainId
    );
    if (check.length === 0) return reply.code(403).send({ error: "not_in_chain" });

    const users = await prisma.user.findMany({
      where:  { restaurantId },
      select: { id: true },
      take:   1,
    });
    if (users.length === 0) return reply.code(404).send({ error: "no_user_for_restaurant" });

    const token = app.jwt.sign(
      { kind: "pro", userId: users[0].id, restaurantId },
      { expiresIn: "8h" }
    );
    return { token };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/chain/restaurants/link — rattacher un établissement par slug
  // Le chain admin saisit le slug du restaurant + son token pro pour prouver la propriété
  // ─────────────────────────────────────────────────────────────────────────
  app.post("/restaurants/link", async (req, reply) => {
    const { chainId } = await requireChain(req, reply);
    const { slug, proToken } = z.object({
      slug:     z.string().min(3).max(60),
      proToken: z.string().min(1),
    }).parse(req.body);

    // Trouver le restaurant par slug
    const restaurants = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM "Restaurant" WHERE slug = $1`, slug
    );
    if (restaurants.length === 0) return reply.code(404).send({ error: "restaurant_not_found" });
    const restaurantId = restaurants[0].id;

    // Vérifier que le token pro est valide pour ce restaurant
    // Rétrocompatibilité : tokens anciens sans "kind" sont acceptés si restaurantId correspond
    let decoded: any;
    try {
      decoded = req.server.jwt.verify(proToken) as any;
      const kindOk = !decoded.kind || decoded.kind === "pro"; // accept tokens without kind (legacy)
      if (!kindOk || decoded.restaurantId !== restaurantId) throw new Error("mismatch");
    } catch {
      return reply.code(403).send({ error: "invalid_pro_token" });
    }

    await prisma.$executeRawUnsafe(
      `UPDATE "Restaurant" SET "chainId" = $1 WHERE id = $2`,
      chainId, restaurantId
    );

    const info = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, name, city, slug FROM "Restaurant" WHERE id = $1`, restaurantId
    );
    return { ok: true, restaurant: info[0] };
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/chain/restaurants/:restaurantId/unlink — détacher un établissement
  // ─────────────────────────────────────────────────────────────────────────
  app.delete("/restaurants/:restaurantId/unlink", async (req, reply) => {
    const { chainId } = await requireChain(req, reply);
    const { restaurantId } = req.params as { restaurantId: string };

    const check = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM "Restaurant" WHERE id = $1 AND "chainId" = $2`, restaurantId, chainId
    );
    if (check.length === 0) return reply.code(403).send({ error: "not_in_chain" });

    await prisma.$executeRawUnsafe(
      `UPDATE "Restaurant" SET "chainId" = NULL, "mapLat" = NULL, "mapLng" = NULL WHERE id = $1`,
      restaurantId
    );
    return { ok: true };
  });
}
