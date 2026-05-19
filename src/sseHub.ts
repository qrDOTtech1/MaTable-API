/**
 * Server-Sent Events hub.
 *
 * Maintient une Map<restaurantId, Set<FastifyReply>> de connexions actives.
 * Les routes (orders, reviews, service-calls, etc.) appellent emitSSE() en
 * parallèle des emitToRestaurant() Socket.IO existants pour pousser un event
 * unidirectionnel aux terminaux NovaOS connectés.
 *
 * Format SSE :
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 *
 * Keep-alive : ":keep-alive\n\n" toutes les 25 s pour ne pas tomber sur les
 * timeouts proxy/Railway.
 */
import type { FastifyReply } from "fastify";

type SseClient = {
  reply: FastifyReply;
  keepAlive: NodeJS.Timeout;
};

const clientsByRestaurant = new Map<string, Set<SseClient>>();

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: "unserializable_payload" });
  }
}

export function registerSseClient(restaurantId: string, reply: FastifyReply): SseClient {
  const set = clientsByRestaurant.get(restaurantId) ?? new Set<SseClient>();
  if (!clientsByRestaurant.has(restaurantId)) clientsByRestaurant.set(restaurantId, set);

  // SSE headers
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.setHeader("Access-Control-Allow-Origin", "*");
  reply.raw.flushHeaders?.();

  // Initial "ready" event so clients see something immediately
  reply.raw.write(`event: ready\ndata: ${safeStringify({ restaurantId, ts: Date.now() })}\n\n`);

  // Keep-alive every 25 s
  const keepAlive = setInterval(() => {
    try {
      reply.raw.write(`:keep-alive ${Date.now()}\n\n`);
    } catch {
      // ignore — close handler will clean up
    }
  }, 25000);

  const client: SseClient = { reply, keepAlive };
  set.add(client);

  return client;
}

export function unregisterSseClient(restaurantId: string, client: SseClient) {
  clearInterval(client.keepAlive);
  const set = clientsByRestaurant.get(restaurantId);
  if (!set) return;
  set.delete(client);
  if (set.size === 0) clientsByRestaurant.delete(restaurantId);
  try {
    client.reply.raw.end();
  } catch {
    // already closed
  }
}

export function emitSSE(restaurantId: string, event: string, payload: unknown) {
  const set = clientsByRestaurant.get(restaurantId);
  if (!set || set.size === 0) return;

  const line = `event: ${event}\ndata: ${safeStringify(payload)}\n\n`;

  for (const client of set) {
    try {
      client.reply.raw.write(line);
    } catch {
      // remove broken client silently
      unregisterSseClient(restaurantId, client);
    }
  }
}

export function sseClientCount(restaurantId?: string): number {
  if (restaurantId) return clientsByRestaurant.get(restaurantId)?.size ?? 0;
  let total = 0;
  for (const set of clientsByRestaurant.values()) total += set.size;
  return total;
}
