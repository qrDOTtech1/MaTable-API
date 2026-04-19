import { Server as SocketServer } from "socket.io";
import type { FastifyInstance } from "fastify";
import { env } from "./env.js";

let io: SocketServer | null = null;

export function initRealtime(app: FastifyInstance) {
  io = new SocketServer(app.server, {
    cors: { origin: env.PUBLIC_WEB_URL, credentials: true },
  });

  io.on("connection", (socket) => {
    const restaurantId = socket.handshake.auth?.restaurantId as string | undefined;
    if (restaurantId) socket.join(`restaurant:${restaurantId}`);
  });

  return io;
}

export function emitToRestaurant(restaurantId: string, event: string, payload: unknown) {
  io?.to(`restaurant:${restaurantId}`).emit(event, payload);
}
