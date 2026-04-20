import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string(),
  JWT_SECRET: z.string().min(16),
  STRIPE_SECRET: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  PUBLIC_WEB_URL: z.string().default("http://localhost:3000"),
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.string().default("development"),

  // Cloudinary (optional) for direct browser uploads
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
});

export const env = schema.parse(process.env);
