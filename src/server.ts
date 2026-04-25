import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import compress from "@fastify/compress";
import { randomUUID } from "crypto";
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

async function build() {
  const app = Fastify({
    // Reuse X-Request-Id from client if present, else generate UUID
    genReqId: (req) => (req.headers["x-request-id"] as string) || randomUUID(),
    logger: {
      transport: env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined,
      // In production, pino emits structured JSON — each log line includes reqId automatically
    },
  });

  // Propagate correlation ID back to the caller
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Request-Id", req.id);
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
  await app.register(compress, { global: true });
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
    initRealtime(app);
    await app.listen({ port: env.PORT, host: "0.0.0.0" });
    app.log.info(`API ready on :${env.PORT}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
