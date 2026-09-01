/**
 * Global Ollama Cloud configuration — single row in GlobalConfig table.
 * Admin sets one API key + models for the entire platform.
 * All restaurant IA features use this config.
 */
import { prisma } from "./db.js";

export type GlobalIaConfig = {
  ollamaApiKey: string | null;
  ollamaLangModel: string;
  ollamaVisionModel: string;
};

const DEFAULTS: GlobalIaConfig = {
  ollamaApiKey: null,
  ollamaLangModel: "gpt-oss:120b",
  ollamaVisionModel: "qwen3-vl:235b",
};

/** Ensure GlobalConfig table + columns exist (idempotent) */
async function ensureGlobalConfigTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "GlobalConfig" (
      id TEXT NOT NULL DEFAULT 'global',
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "GlobalConfig_pkey" PRIMARY KEY (id)
    )
  `);
  await prisma.$executeRawUnsafe(`ALTER TABLE "GlobalConfig" ADD COLUMN IF NOT EXISTS "ollamaApiKey" TEXT`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "GlobalConfig" ADD COLUMN IF NOT EXISTS "ollamaLangModel" TEXT NOT NULL DEFAULT 'gpt-oss:120b'`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "GlobalConfig" ADD COLUMN IF NOT EXISTS "ollamaVisionModel" TEXT NOT NULL DEFAULT 'qwen3-vl:235b'`);
  // Config billing plateforme (Stripe Billing pour facturer les restos) — tout configurable
  await prisma.$executeRawUnsafe(`ALTER TABLE "GlobalConfig" ADD COLUMN IF NOT EXISTS "platformBilling" JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await prisma.$executeRawUnsafe(`INSERT INTO "GlobalConfig" (id) VALUES ('global') ON CONFLICT (id) DO NOTHING`);
}

// Cache the schema-ensure as a Promise so concurrent cold-start calls share
// the same in-flight `CREATE TABLE IF NOT EXISTS` sequence instead of racing.
let tableEnsuredPromise: Promise<void> | null = null;
function ensureOnce(): Promise<void> {
  if (tableEnsuredPromise) return tableEnsuredPromise;
  tableEnsuredPromise = ensureGlobalConfigTable().catch((e) => {
    console.error("[globalIaConfig] ensureTable error:", e);
    tableEnsuredPromise = null; // allow retry on next call
    throw e;
  });
  return tableEnsuredPromise;
}

// In-memory cache: the row is written from the admin panel (a different app),
// rarely — well under once per minute in practice. A short TTL avoids one DB
// round-trip per AI request (17 call sites, all hot) and reflects admin
// updates within the window.
const CACHE_TTL_MS = 30_000;
let cached: { value: GlobalIaConfig; expiresAt: number } | null = null;

/** Invalidate the in-memory cache (call after a write to GlobalConfig). */
export function invalidateGlobalIaConfigCache(): void {
  cached = null;
}

/** Fetch the global Ollama Cloud config (single row, id = 'global') */
export async function getGlobalIaConfig(): Promise<GlobalIaConfig> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;

  try { await ensureOnce(); } catch { /* logged in ensureOnce; fall through */ }

  try {
    const rows = await prisma.$queryRaw<Array<{
      ollamaApiKey: string | null;
      ollamaLangModel: string;
      ollamaVisionModel: string;
    }>>`
      SELECT "ollamaApiKey", "ollamaLangModel", "ollamaVisionModel"
      FROM "GlobalConfig" WHERE id = 'global' LIMIT 1
    `;
    if (rows.length === 0) {
      console.warn("[globalIaConfig] No row found — returning DEFAULTS (key=null)");
      cached = { value: DEFAULTS, expiresAt: now + CACHE_TTL_MS };
      return DEFAULTS;
    }
    const cfg = rows[0];
    // Log only on cache miss (once per TTL, not once per AI request), and
    // never log any part of the API key — just whether it is set.
    console.log(`[globalIaConfig] loaded — key=${cfg.ollamaApiKey ? "SET" : "NULL"} lang=${cfg.ollamaLangModel} vision=${cfg.ollamaVisionModel}`);
    cached = { value: cfg, expiresAt: now + CACHE_TTL_MS };
    return cfg;
  } catch (e) {
    console.error("[globalIaConfig] query error:", e);
    return DEFAULTS;
  }
}

/**
 * Call Ollama Cloud API and return the text response.
 * Uses OpenAI-compatible chat endpoint at https://ollama.com/api/chat
 * Throws if no API key or provider error.
 */
export async function callCloudAI(
  config: GlobalIaConfig,
  prompt: string,
  maxTokens = 1024
): Promise<string> {
  const { ollamaApiKey, ollamaLangModel } = config;
  if (!ollamaApiKey) throw new Error("IA_KEY_MISSING");

  const res = await fetch("https://ollama.com/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ollamaApiKey}`,
    },
    body: JSON.stringify({
      model: ollamaLangModel,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`ollama error ${res.status}: ${errorText}`);
  }

  const data = await res.json() as any;
  // Ollama API returns { message: { content: "..." } }
  return (data.message?.content ?? data.choices?.[0]?.message?.content ?? "") as string;
}
