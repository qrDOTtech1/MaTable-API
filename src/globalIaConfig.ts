/**
 * Global IA configuration — single row in GlobalConfig table.
 * Admin sets one API key + models for the entire platform.
 * All restaurant IA features use this config.
 */
import { prisma } from "./db.js";

export type GlobalIaConfig = {
  iaApiKey: string | null;
  iaLangModel: string;
  iaVisionModel: string;
};

export type IaProvider = "openai" | "anthropic" | "google" | "mistral";

export function detectProvider(model: string): IaProvider {
  if (model.startsWith("claude-"))  return "anthropic";
  if (model.startsWith("gemini-"))  return "google";
  if (model.startsWith("mistral"))  return "mistral";
  return "openai";
}

/** Fetch the global IA config (single row, id = 'global') */
export async function getGlobalIaConfig(): Promise<GlobalIaConfig> {
  const rows = await prisma.$queryRaw<Array<{
    iaApiKey: string | null;
    iaLangModel: string;
    iaVisionModel: string;
  }>>`
    SELECT "iaApiKey", "iaLangModel", "iaVisionModel"
    FROM "GlobalConfig" WHERE id = 'global' LIMIT 1
  `;
  if (rows.length === 0) {
    return { iaApiKey: null, iaLangModel: "gpt-4o-mini", iaVisionModel: "gpt-4o" };
  }
  return rows[0];
}

/**
 * Call the correct cloud AI provider and return the text response.
 * Throws if no API key or provider error.
 */
export async function callCloudAI(
  config: GlobalIaConfig,
  prompt: string,
  maxTokens = 300
): Promise<string> {
  const { iaApiKey, iaLangModel } = config;
  if (!iaApiKey) throw new Error("IA_KEY_MISSING");

  const provider = detectProvider(iaLangModel);
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (provider === "openai" || provider === "mistral") {
    const base = provider === "openai"
      ? "https://api.openai.com/v1"
      : "https://api.mistral.ai/v1";
    headers["Authorization"] = `Bearer ${iaApiKey}`;
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST", headers,
      body: JSON.stringify({ model: iaLangModel, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens }),
    });
    if (!res.ok) throw new Error(`AI_PROVIDER_ERROR:${res.status}`);
    const d = await res.json() as any;
    return d.choices[0].message.content as string;

  } else if (provider === "anthropic") {
    headers["x-api-key"] = iaApiKey;
    headers["anthropic-version"] = "2023-06-01";
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers,
      body: JSON.stringify({ model: iaLangModel, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) throw new Error(`AI_PROVIDER_ERROR:${res.status}`);
    const d = await res.json() as any;
    return d.content[0].text as string;

  } else {
    // google
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${iaLangModel}:generateContent?key=${iaApiKey}`,
      {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
      }
    );
    if (!res.ok) throw new Error(`AI_PROVIDER_ERROR:${res.status}`);
    const d = await res.json() as any;
    return d.candidates[0].content.parts[0].text as string;
  }
}
