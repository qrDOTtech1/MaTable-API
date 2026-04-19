import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { z } from "zod";
import { prisma } from "@atable/db";
import { requireSessionToken } from "../auth.js";
import { env } from "../env.js";
import { emitToRestaurant } from "../realtime.js";

export async function stripeRoutes(app: FastifyInstance) {
  const stripe = env.STRIPE_SECRET ? new Stripe(env.STRIPE_SECRET) : null;

  app.post("/checkout", async (req, reply) => {
    if (!stripe) return reply.code(503).send({ error: "stripe_not_configured" });
    const decoded = await requireSessionToken(req, reply);
    const { orderId } = z.object({ orderId: z.string() }).parse(req.body);
    const order = await prisma.order.findFirst({
      where: { id: orderId, sessionId: decoded.sessionId },
    });
    if (!order) return reply.code(404).send({ error: "order_not_found" });

    const items = order.items as Array<{ name: string; priceCents: number; quantity: number }>;
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: items.map((i) => ({
        quantity: i.quantity,
        price_data: {
          currency: "eur",
          product_data: { name: i.name },
          unit_amount: i.priceCents,
        },
      })),
      success_url: `${env.PUBLIC_WEB_URL}/order/${decoded.tableId}?paid=1`,
      cancel_url: `${env.PUBLIC_WEB_URL}/order/${decoded.tableId}`,
      metadata: { orderId: order.id, sessionId: order.sessionId, tableId: order.tableId },
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
        const orderId = s.metadata?.orderId;
        const sessionId = s.metadata?.sessionId;
        if (orderId && sessionId) {
          const order = await prisma.order.update({
            where: { id: orderId },
            data: { status: "PAID" },
            include: { table: true },
          });
          await prisma.tableSession.update({
            where: { id: sessionId },
            data: { active: false, closedAt: new Date() },
          });
          emitToRestaurant(order.table.restaurantId, "order:paid", {
            id: order.id,
            tableId: order.tableId,
            tableNumber: order.table.number,
          });
        }
      }
      return { received: true };
    }
  );
}
