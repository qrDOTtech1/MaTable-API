import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import { randomUUID } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { env } from "./env.js";
import { prisma } from "./db.js";
import { initRealtime } from "./realtime.js";
import { publicRoutes } from "./routes/public.js";
import { proRoutes } from "./routes/pro.js";
import { stripeRoutes } from "./routes/stripe.js";
import { aiRoutes } from "./routes/ai.js";
import { serverPortalRoutes } from "./routes/serverPortal.js";
import { caissePortalRoutes } from "./routes/caissePortal.js";
import { cuisinePortalRoutes } from "./routes/cuisinePortal.js";
import { invoiceRoutes } from "./routes/invoice.js";
import { socialRoutes } from "./routes/social.js";

/**
 * Split a SQL file into individual statements.
 * Handles:
 *  - Single-line comments (-- ...)
 *  - DO $$ ... $$ blocks (PL/pgSQL — contain inner semicolons that must NOT split)
 *  - Standard semicolon-terminated statements
 */
function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inDollarQuote = false;
  let i = 0;

  while (i < sql.length) {
    // Skip single-line comments (outside dollar-quoted blocks)
    if (!inDollarQuote && sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }

    // Toggle dollar-quoting on $$
    if (sql[i] === "$" && sql[i + 1] === "$") {
      inDollarQuote = !inDollarQuote;
      current += "$$";
      i += 2;
      continue;
    }

    // Statement terminator — only outside dollar-quoted blocks
    if (sql[i] === ";" && !inDollarQuote) {
      const stmt = current.trim();
      if (stmt) statements.push(stmt + ";");
      current = "";
      i++;
      continue;
    }

    current += sql[i];
    i++;
  }

  // Catch any trailing statement without a final semicolon
  const tail = current.trim();
  if (tail) statements.push(tail);

  // Filter out blank or comment-only entries
  return statements.filter((s) => s.replace(/--[^\n]*/g, "").trim().length > 0);
}

// Execute ensure_columns.sql at startup to create/update tables
async function initDb() {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = join(__filename, "..");
    const sqlPath = join(__dirname, "..", "prisma", "ensure_columns.sql");
    const sql = readFileSync(sqlPath, "utf-8");

    // Prisma $executeRawUnsafe cannot run multiple statements in one call
    // (PostgreSQL rejects multi-command prepared statements → error 42601).
    // Split the file and execute each statement individually.
    const statements = splitSqlStatements(sql);
    let ok = 0;
    for (const stmt of statements) {
      try {
        await prisma.$executeRawUnsafe(stmt);
        ok++;
      } catch (stmtErr: any) {
        // Log but keep going — most failures are benign (column/table already exists)
        console.warn(`⚠️  SQL stmt skipped: ${stmtErr.message?.split("\n")[0]}`);
      }
    }
    console.log(`✓ Database schema initialized (${ok}/${statements.length} statements)`);
  } catch (err) {
    console.error("⚠️  Failed to initialize database schema:", err);
    // Non-blocking: continue even if this fails
  }
}

async function build() {
  const app = Fastify({
    // Reuse X-Request-Id from client if present, else generate UUID
    genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
    // Increase body limit for vision routes (base64 images up to ~2MB)
    bodyLimit: 10 * 1024 * 1024, // 10 MB
    logger: {
      transport: env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
      // In production, pino emits structured JSON — each log line includes reqId automatically
    },
  });

  // Propagate correlation ID back to the caller
  // IMPORTANT: Skip hijacked replies (SSE streams) — headers were already written manually
  app.addHook("onSend", async (req, reply) => {
    if (!(reply as any).hijacked) {
      reply.header("X-Request-Id", req.id);
    }
  });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      (req as any).rawBody = body;
      try {
        const json = body.length ? JSON.parse(body.toString("utf8")) : {};
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    }
  );

  await app.register(cors, {
    // Reflect the request origin — JWT auth is the security layer, not CORS origin-checking
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  await app.register(cookie);
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1024 * 1024, // 5MB
      files: 1,
    },
  });
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(compress, { 
    global: true, 
    // DO NOT compress SSE streams. Fastify/compress buffers output, which breaks SSE and causes "Premature close"
    // and "Failed to fetch" when the buffer gets too large or the connection times out.
    customTypes: /^(text\/(?!event-stream).*|application\/.*)$/, 
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.get("/health", async () => {
    const t0 = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, dbLatencyMs: Date.now() - t0, uptime: Math.floor(process.uptime()), memMb: Math.round(process.memoryUsage().rss / 1048576) };
  });

  await app.register(publicRoutes, { prefix: "/api" });
  await app.register(proRoutes, { prefix: "/api/pro" });
  await app.register(stripeRoutes, { prefix: "/api/stripe" });
  await app.register(aiRoutes, { prefix: "/api/pro" });
  await app.register(serverPortalRoutes, { prefix: "/api/server" });
  await app.register(caissePortalRoutes, { prefix: "/api/caisse" });
  await app.register(cuisinePortalRoutes, { prefix: "/api/cuisine" });
  await app.register(invoiceRoutes, { prefix: "/api" });
  await app.register(socialRoutes, { prefix: "/api" });

  return app;
}

build()
  .then(async (app) => {
    await initDb();
    initRealtime(app);
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`API ready on :${env.PORT}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
