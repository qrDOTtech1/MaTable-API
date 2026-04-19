import type { FastifyReply, FastifyRequest } from "fastify";

export type SessionTokenPayload = {
  kind: "session";
  sessionId: string;
  tableId: string;
  restaurantId: string;
};

export type ProTokenPayload = {
  kind: "pro";
  userId: string;
  restaurantId: string;
};

export async function requireSessionToken(req: FastifyRequest, reply: FastifyReply) {
  try {
    const decoded = await req.jwtVerify<SessionTokenPayload>();
    if (decoded.kind !== "session") throw new Error("wrong kind");
    return decoded;
  } catch {
    reply.code(401).send({ error: "invalid_session_token" });
    throw reply;
  }
}

export async function requirePro(req: FastifyRequest, reply: FastifyReply) {
  try {
    const token = req.cookies["atable_pro"];
    if (!token) throw new Error("no cookie");
    const decoded = req.server.jwt.verify<ProTokenPayload>(token);
    if (decoded.kind !== "pro") throw new Error("wrong kind");
    return decoded;
  } catch {
    reply.code(401).send({ error: "unauthorized" });
    throw reply;
  }
}
