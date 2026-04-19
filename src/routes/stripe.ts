import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireSessionToken } from "../auth.js";
import { env } from "../env.js";
import { emitToRestaurant } from "../realtime.js";

export async function stripeRoutes(app: FastifyInstance) {
  const stripe = env.STRIPE_SECRET ? new Stripe(env.STRIPE_SECRET) : null;

  app.post("/checkout", async (req, reply) => {
    if (!stripe) return reply.code(503).send({ error: "stripe_not_configured" });
    const decoded = await requireSessionToken(req, reply);

    // Session-level "addition": pay everything not yet paid for the table session.
    // We keep backward compatibility with an optional orderId.
    const { orderId } = z
      .object({ orderId: z.string().optional() })
      .default({})
      .parse(req.body ?? {});

    const sessionRow = await prisma.tableSession.findUnique({ where: { id: decoded.sessionId } });
    if (!sessionRow || !sessionRow.active) {
      return reply.code(401).send({ error: "session_closed" });
    }

    const orders = orderId
      ? await prisma.order.findMany({ where: { id: orderId, sessionId: decoded.sessionId } })
      : await prisma.order.findMany({
          where: {
            sessionId: decoded.sessionId,
            status: { notIn: ["PAID", "CANCELLED"] },
          },
          orderBy: { createdAt: "asc" },
        });

    if (!orders.length) {
      return reply.code(400).send({ error: orderId ? "order_not_found" : "nothing_to_pay" });
    }

    const itemsByKey = new Map<string, { name: string; priceCents: number; quantity: number }>();
    for (const o of orders) {
      const items = o.items as Array<{ name: string; priceCents: number; quantity: number }>;
      for (const it of items) {
        const key = `${it.name}__${it.priceCents}`;
        const prev = itemsByKey.get(key);
        if (prev) prev.quantity += it.quantity;
        else itemsByKey.set(key, { name: it.name, priceCents: it.priceCents, quantity: it.quantity });
      }
    }

    const mergedItems = Array.from(itemsByKey.values()).filter((i) => i.quantity > 0);
    if (!mergedItems.length) return reply.code(400).send({ error: "nothing_to_pay" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: mergedItems.map((i) => ({
        quantity: i.quantity,
        price_data: {
          currency: "eur",
          product_data: { name: i.name },
          unit_amount: i.priceCents,
        },
      })),
      success_url: `${env.PUBLIC_WEB_URL}/order/${decoded.tableId}?paid=1`,
      cancel_url: `${env.PUBLIC_WEB_URL}/order/${decoded.tableId}`,
      metadata: {
        // If orderId is present we still use session-level settlement, but keep it for debug.
        orderId: orderId ?? "",
        sessionId: decoded.sessionId,
        tableId: decoded.tableId,
        restaurantId: decoded.restaurantId,
      },
    });
    return { url: session.url };
  });

  app.post(
    "/webhook",
    { config: { rawBody: true } },
    async (req, reply) => {
      if (!stripe || !env.STRIPE_WEBHOOK_SECRET) {
        return reply.code(503).send({ error: "stripe_not_configured" });
      }
      const sig = req.headers["stripe-signature"] as string;
      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(
          (req as any).rawBody,
          sig,
          env.STRIPE_WEBHOOK_SECRET
        );
      } catch (e: any) {
        return reply.code(400).send(`bad signature: ${e.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const s = event.data.object as Stripe.Checkout.Session;
        const sessionId = s.metadata?.sessionId;
        const tableId = s.metadata?.tableId;
        const restaurantId = s.metadata?.restaurantId;

        if (sessionId && tableId) {
          await prisma.order.updateMany({
            where: { sessionId, status: { notIn: ["PAID", "CANCELLED"] } },
            data: { status: "PAID" },
          });
          await prisma.tableSession.update({
            where: { id: sessionId },
            data: { active: false, closedAt: new Date() },
          });

          // Payload isn't used by the web currently; keep an event to refresh the dashboard.
          if (restaurantId) {
            emitToRestaurant(restaurantId, "order:paid", { tableId });
          }
        }
      }
      return { received: true };
    }
  );
}
