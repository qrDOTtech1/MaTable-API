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

/** Fetch the global Ollama Cloud config (single row, id = 'global') */
export async function getGlobalIaConfig(): Promise<GlobalIaConfig> {
  const rows = await prisma.$queryRaw<Array<{
    ollamaApiKey: string | null;
    ollamaLangModel: string;
    ollamaVisionModel: string;
  }>>`
    SELECT "ollamaApiKey", "ollamaLangModel", "ollamaVisionModel"
    FROM "GlobalConfig" WHERE id = 'global' LIMIT 1
  `;
  if (rows.length === 0) {
    return { ollamaApiKey: null, ollamaLangModel: "gpt-oss:120b", ollamaVisionModel: "qwen3-vl:235b" };
  }
  return rows[0];
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
