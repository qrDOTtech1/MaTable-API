import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(16),
  STRIPE_SECRET: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  // Comma-separated list of additional allowed origins (e.g. Railway preview URLs)
  EXTRA_ALLOWED_ORIGINS: z.string().optional(),
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.string().default("development"),
});

export const env = schema.parse(process.env);
