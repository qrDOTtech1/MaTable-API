import Fastify from "fastify";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import jwt from "@fastify/jwt";
import rateLimit from "@fastify/rate-limit";
import { env } from "./env.js";
import { initRealtime } from "./realtime.js";
import { publicRoutes } from "./routes/public.js";
import { proRoutes } from "./routes/pro.js";
import { stripeRoutes } from "./routes/stripe.js";

async function build() {
  const app = Fastify({
    logger: { transport: env.NODE_ENV === "development" ? { target: "pino-pretty" } : undefined },
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

  await app.register(cors, { origin: env.PUBLIC_WEB_URL, credentials: true });
  await app.register(cookie);
  await app.register(jwt, { secret: env.JWT_SECRET });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.get("/health", async () => ({ ok: true }));

  await app.register(publicRoutes, { prefix: "/api" });
  await app.register(proRoutes, { prefix: "/api/pro" });
  await app.register(stripeRoutes, { prefix: "/api/stripe" });

  return app;
}

build()
  .then(async (app) => {
    initRealtime(app);
    await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
    app.log.info(`API ready on :${env.API_PORT}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
