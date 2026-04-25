/**
 * Invoice Routes — /api/invoice/*
 *
 * GET  /api/invoice/:sessionId       → public invoice data (no auth, by sessionId)
 * POST /api/invoice/:sessionId/send  → send invoice by email (requires Resend API key)
 *
 * Pro route:
 * GET  /api/pro/invoices?email=...   → search closed sessions by customer email
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requirePro } from "../auth.js";
import { env } from "../env.js";

export async function invoiceRoutes(app: FastifyInstance) {

  // ── GET /api/invoice/:sessionId ────────────────────────────────────────────
  app.get("/invoice/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };

    const session = await prisma.tableSession.findUnique({
      where: { id: sessionId },
      include: {
        table: {
          select: {
            number: true,
            zone: true,
            restaurant: {
              select: {
                name: true,
                address: true,
                city: true,
                phone: true,
                email: true,
              },
            },
          },
        },
        orders: {
          where: { status: { in: ["PAID", "SERVED"] } },
          select: { id: true, items: true, totalCents: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });

    // tipCents stored on session (added via ensure_columns.sql)
    const tipCents: number = (session as any).tipCents ?? 0;
    const subtotalCents = (session.orders as any[]).reduce((s: number, o: any) => s + o.totalCents, 0);
    const totalCents = subtotalCents + tipCents;

    return {
      sessionId: session.id,
      closedAt: session.closedAt,
      table: {
        number: session.table.number,
        zone: (session.table as any).zone ?? null,
      },
      restaurant: {
        name: session.table.restaurant.name,
        address: session.table.restaurant.address ?? null,
        city: session.table.restaurant.city ?? null,
        phone: session.table.restaurant.phone ?? null,
        email: session.table.restaurant.email ?? null,
      },
      orders: (session.orders as any[]).map((o: any) => ({
        id: o.id,
        items: Array.isArray(o.items) ? o.items : [],
        totalCents: o.totalCents,
        createdAt: o.createdAt,
      })),
      subtotalCents,
      tipCents,
      totalCents,
      paymentMode: (session as any).billPaymentMode ?? null,
      customerEmail: (session as any).customerEmail ?? null,
    };
  });

  // ── POST /api/invoice/:sessionId/send ──────────────────────────────────────
  app.post("/invoice/:sessionId/send", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    const { email } = z.object({ email: z.string().email() }).parse(req.body);

    // Store email on session for future reference
    await prisma.$executeRaw`
      UPDATE "TableSession" SET "customerEmail" = ${email} WHERE id = ${sessionId}
    `;

    // Send via Resend if configured
    const resendKey = (env as any).RESEND_API_KEY;
    if (!resendKey) {
      // Store email but can't send — return success anyway
      return { ok: true, sent: false, message: "Email sauvegardé (service email non configuré)" };
    }

    const invoiceUrl = `${env.PUBLIC_WEB_URL}/invoice/${sessionId}`;

    const session = await prisma.tableSession.findUnique({
      where: { id: sessionId },
      include: {
        table: { select: { number: true, restaurant: { select: { name: true } } } },
        orders: { where: { status: { in: ["PAID","SERVED"] } }, select: { items: true, totalCents: true } },
      },
    });

    if (!session) return reply.code(404).send({ error: "SESSION_NOT_FOUND" });

    const tipCents: number = (session as any).tipCents ?? 0;
    const subtotal = (session.orders as any[]).reduce((s: number, o: any) => s + o.totalCents, 0);
    const total = subtotal + tipCents;
    const fmt = (c: number) => (c / 100).toFixed(2) + " €";

    const lines = (session.orders as any[])
      .flatMap((o: any) => (Array.isArray(o.items) ? o.items : []))
      .map((item: any) => `<tr><td>${item.quantity}× ${item.name}</td><td style="text-align:right">${fmt(item.quantity * item.priceCents)}</td></tr>`)
      .join("");

    const html = `
      <div style="font-family:monospace;max-width:480px;margin:auto;padding:32px;border:1px solid #eee;border-radius:12px">
        <h1 style="text-align:center;margin-bottom:4px">${session.table.restaurant.name}</h1>
        <p style="text-align:center;color:#888;font-size:12px;margin-bottom:24px">TICKET DE CAISSE</p>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
          <tbody>${lines}</tbody>
        </table>
        <hr style="border:1px dashed #ddd;margin:12px 0"/>
        <table style="width:100%"><tbody>
          ${tipCents > 0 ? `<tr><td>Sous-total</td><td style="text-align:right">${fmt(subtotal)}</td></tr><tr><td>Pourboire</td><td style="text-align:right">${fmt(tipCents)}</td></tr>` : ""}
          <tr><td><strong>TOTAL</strong></td><td style="text-align:right"><strong>${fmt(total)}</strong></td></tr>
        </tbody></table>
        <hr style="border:1px dashed #ddd;margin:12px 0"/>
        <p style="text-align:center;font-size:11px;color:#aaa">Merci pour votre visite · MaTable</p>
        <p style="text-align:center;margin-top:8px"><a href="${invoiceUrl}">Voir le ticket en ligne</a></p>
      </div>`;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${resendKey}` },
      body: JSON.stringify({
        from: "Votre-ticket@matable.pro",
        to: [email],
        subject: `Votre ticket · ${session.table.restaurant.name} · Table ${session.table.number}`,
        html,
      }),
    });

    if (!resendRes.ok) {
      const err = await resendRes.text();
      return reply.code(500).send({ error: "EMAIL_FAILED", detail: err });
    }

    return { ok: true, sent: true };
  });

  // ── GET /api/pro/invoices ──────────────────────────────────────────────────
  // Search closed sessions by customer email (pro auth)
  app.get("/pro/invoices", async (req, reply) => {
    const me = await requirePro(req, reply);
    const { email, limit } = z.object({
      email: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query ?? {});

    // Raw query to access customerEmail column
    type Row = { id: string; closedAt: Date | null; billPaymentMode: string | null; tipCents: number | null; customerEmail: string | null; tableNumber: number };
    let rows: Row[];
    if (email) {
      const pattern = `%${email}%`;
      rows = await prisma.$queryRaw<Row[]>`
        SELECT ts.id, ts."closedAt", ts."billPaymentMode", ts."tipCents", ts."customerEmail",
               t.number AS "tableNumber"
        FROM "TableSession" ts
        JOIN "Table" t ON t.id = ts."tableId"
        WHERE t."restaurantId" = ${me.restaurantId}
          AND ts.active = false
          AND ts."customerEmail" ILIKE ${pattern}
        ORDER BY ts."closedAt" DESC NULLS LAST
        LIMIT ${limit}
      `;
    } else {
      rows = await prisma.$queryRaw<Row[]>`
        SELECT ts.id, ts."closedAt", ts."billPaymentMode", ts."tipCents", ts."customerEmail",
               t.number AS "tableNumber"
        FROM "TableSession" ts
        JOIN "Table" t ON t.id = ts."tableId"
        WHERE t."restaurantId" = ${me.restaurantId}
          AND ts.active = false
        ORDER BY ts."closedAt" DESC NULLS LAST
        LIMIT ${limit}
      `;
    }

    // Compute total for each session
    const enriched = await Promise.all(rows.map(async (r) => {
      const agg = await prisma.order.aggregate({
        where: { sessionId: r.id, status: "PAID" },
        _sum: { totalCents: true },
      });
      const subtotal = agg._sum.totalCents ?? 0;
      const tip = r.tipCents ?? 0;
      return { ...r, subtotalCents: subtotal, totalCents: subtotal + tip };
    }));

    return { invoices: enriched };
  });
}
