import { env } from "../env.js";
import { requirePro } from "../auth.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export async function aiRoutes(app: FastifyInstance) {
  app.post("/chat", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { model, messages, stream } = z.object({
      model: z.string().default("llama3"),
      messages: z.array(z.object({
        role: z.enum(["user", "assistant", "system"]),
        content: z.string()
      })),
      stream: z.boolean().default(false)
    }).parse(req.body);

    const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.statusText}`);
      }

      if (stream) {
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        });
        
        const reader = response.body?.getReader();
        if (!reader) return reply.send({ error: "No body" });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          reply.raw.write(value);
        }
        return reply.raw.end();
      }

      const data = await response.json();
      return data;
    } catch (error: any) {
      app.log.error(error);
      return reply.code(500).send({ error: "AI_SERVICE_UNAVAILABLE", details: error.message });
    }
  });
}
