import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@atable/db";
import { requireSessionToken } from "../auth.js";
import { emitToRestaurant } from "../realtime.js";

export async function publicRoutes(app: FastifyInstance) {
  app.get("/tables/:tableId", async (req, reply) => {
    const { tableId } = req.params as { tableId: string };
    const table = await prisma.table.findUnique({
      where: { id: tableId },
      include: {
        restaurant: {
          select: {
            id: true,
            name: true,
            menuItems: { where: { available: true }, orderBy: { category: "asc" } },
          },
        },
      },
    });
    if (!table) return reply.code(404).send({ error: "table_not_found" });
    return {
      table: { id: table.id, number: table.number },
      restaurant: { id: table.restaurant.id, name: table.restaurant.name },
      menu: table.restaurant.menuItems,
    };
  });

  app.post("/session", async (req, reply) => {
    const { tableId } = z.object({ tableId: z.string().uuid() }).parse(req.body);
    const table = await prisma.table.findUnique({ where: { id: tableId } });
    if (!table) return reply.code(404).send({ error: "table_not_found" });

    let session = await prisma.tableSession.findFirst({
      where: { tableId, active: true },
      orderBy: { createdAt: "desc" },
    });
    if (!session) {
      session = await prisma.tableSession.create({ data: { tableId } });
    }

    const token = await reply.jwtSign(
      {
        kind: "session",
        sessionId: session.id,
        tableId,
        restaurantId: table.restaurantId,
      },
      { expiresIn: "12h" }
    );
    return { token, sessionId: session.id };
  });

  app.post("/orders", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const body = z
      .object({
        items: z
          .array(z.object({ menuItemId: z.string(), quantity: z.number().int().min(1) }))
          .min(1),
      })
      .parse(req.body);

    const session = await prisma.tableSession.findUnique({ where: { id: decoded.sessionId } });
    if (!session || !session.active) return reply.code(401).send({ error: "session_closed" });

    const menuItems = await prisma.menuItem.findMany({
      where: {
        id: { in: body.items.map((i) => i.menuItemId) },
        restaurantId: decoded.restaurantId,
        available: true,
      },
    });
    const byId = new Map(menuItems.map((m) => [m.id, m]));
    const lines = body.items.map((i) => {
      const m = byId.get(i.menuItemId);
      if (!m) throw reply.code(400).send({ error: "unknown_item" });
      return { menuItemId: m.id, name: m.name, quantity: i.quantity, priceCents: m.priceCents };
    });
    const totalCents = lines.reduce((s, l) => s + l.priceCents * l.quantity, 0);

    const order = await prisma.order.create({
      data: {
        tableId: decoded.tableId,
        sessionId: decoded.sessionId,
        items: lines,
        totalCents,
      },
      include: { table: true },
    });

    emitToRestaurant(decoded.restaurantId, "order:new", {
      id: order.id,
      tableId: order.tableId,
      tableNumber: order.table.number,
      items: lines,
      totalCents,
      createdAt: order.createdAt,
      status: order.status,
    });

    return { orderId: order.id, totalCents };
  });

  app.get("/orders/mine", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const orders = await prisma.order.findMany({
      where: { sessionId: decoded.sessionId },
      orderBy: { createdAt: "desc" },
    });
    return { orders };
  });
}
