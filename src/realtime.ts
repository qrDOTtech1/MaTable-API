import { Server as SocketServer } from "socket.io";
import type { FastifyInstance } from "fastify";
import { env } from "./env.js";
import { emitSSE } from "./sseHub.js";

let io: SocketServer | null = null;

export function initRealtime(app: FastifyInstance) {
  io = new SocketServer(app.server, {
    cors: { origin: true, credentials: true },
  });

  io.on("connection", (socket) => {
    const restaurantId = socket.handshake.auth?.restaurantId as string | undefined;
    if (restaurantId) socket.join(`restaurant:${restaurantId}`);

    const sessionId = socket.handshake.auth?.sessionId as string | undefined;
    if (sessionId) socket.join(`session:${sessionId}`);
  });

  return io;
}

// Emet a la fois sur Socket.IO (clients web) ET sur le hub SSE (terminaux NovaOS).
// Tous les appels existants `emitToRestaurant(...)` poussent donc automatiquement
// sur les 2 transports sans modification au site d'appel.
export function emitToRestaurant(restaurantId: string, event: string, payload: unknown) {
  io?.to(`restaurant:${restaurantId}`).emit(event, payload);
  emitSSE(restaurantId, event, payload);
}

export function emitToSession(sessionId: string, event: string, payload: unknown) {
  io?.to(`session:${sessionId}`).emit(event, payload);
}
