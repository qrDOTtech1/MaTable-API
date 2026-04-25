import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireSessionToken } from "../auth.js";
import { emitToRestaurant } from "../realtime.js";
import { sendEmail, reservationConfirmationHtml, canSendEmail } from "../email.js";

export async function publicRoutes(app: FastifyInstance) {
  app.get("/testimonials", async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(12).optional() })
      .parse(req.query ?? {});

    const testimonials = await prisma.testimonial.findMany({
      where: { published: true },
      orderBy: { updatedAt: "desc" },
      take: limit ?? 3,
      include: { restaurant: { select: { name: true, city: true } } },
    });

    return {
      testimonials: testimonials.map((t) => ({
        id: t.id,
        displayName: t.displayName,
        displayRole: t.displayRole,
        quote: t.quote,
        rating: t.rating,
        restaurantName: t.restaurant.name,
        restaurantCity: t.restaurant.city,
        updatedAt: t.updatedAt,
      })),
    };
  });

  app.get("/media/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const media = await prisma.media.findUnique({ where: { id } });
    if (!media) return reply.code(404).send({ error: "not_found" });

    reply.header("Content-Type", media.mimeType);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(Buffer.from(media.bytes as any));
  });

  app.get("/photo/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const photo = await prisma.photo.findUnique({ where: { id } });
    if (!photo) return reply.code(404).send({ error: "not_found" });
    reply.header("Content-Type", photo.mimeType);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    return reply.send(Buffer.from(photo.bytes as any));
  });

  app.get("/tables/:tableId", async (req, reply) => {
    const { tableId } = req.params as { tableId: string };
    const table = await prisma.table.findUnique({
      where: { id: tableId },
      include: {
        assignedServer: { select: { id: true, name: true, photoUrl: true } },
        restaurant: {
          select: {
            id: true,
            name: true,
            slug: true,
            tipsEnabled: true,
            reviewsEnabled: true,
            serviceCallEnabled: true,
            openingHours: { orderBy: { dayOfWeek: "asc" } },
            menuItems: { where: { available: true }, orderBy: { category: "asc" } },
          },
        },
      },
    });
    if (!table) return reply.code(404).send({ error: "table_not_found" });

    // Also check for an active session's server (may differ from default)
    let sessionServer = null;
    const activeSession = await prisma.tableSession.findFirst({
      where: { tableId, active: true },
      include: { server: { select: { id: true, name: true, photoUrl: true } } },
      orderBy: { createdAt: "desc" },
    });
    if (activeSession?.server) sessionServer = activeSession.server;

    const server = sessionServer ?? table.assignedServer ?? null;

    return {
      table: { id: table.id, number: table.number, zone: (table as any).zone },
      restaurant: {
        id: table.restaurant.id,
        name: table.restaurant.name,
        slug: (table.restaurant as any).slug,
        tipsEnabled: (table.restaurant as any).tipsEnabled ?? false,
        reviewsEnabled: (table.restaurant as any).reviewsEnabled ?? false,
        serviceCallEnabled: (table.restaurant as any).serviceCallEnabled ?? false,
        openingHours: table.restaurant.openingHours,
      },
      menu: await (async () => {
        const ids = table.restaurant.menuItems.map((m) => m.id);
        type WR = { id: string; waitMinutes: number };
        let wr: WR[] = [];
        if (ids.length > 0) {
          wr = await prisma.$queryRaw<WR[]>`
            SELECT id, COALESCE("waitMinutes", 0)::int AS "waitMinutes"
            FROM "MenuItem" WHERE id = ANY(${ids}::text[])
          `;
        }
        const wm = new Map(wr.map((r) => [r.id, r.waitMinutes]));
        return table.restaurant.menuItems.map((m) => ({ ...m, waitMinutes: wm.get(m.id) ?? 0 }));
      })(),
      server: server ? { id: server.id, name: server.name, photoUrl: server.photoUrl } : null,
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
      // Auto-assign the table's default server to the new session
      session = await prisma.tableSession.create({
        data: {
          tableId,
          serverId: (table as any).assignedServerId ?? null,
        },
      });
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

  app.get("/r/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      include: {
        menuItems: { where: { available: true }, orderBy: { category: "asc" } },
        openingHours: { orderBy: { dayOfWeek: "asc" } },
        photos: { orderBy: { position: "asc" } },
        servers: {
          include: { schedules: { orderBy: { dayOfWeek: "asc" } } },
        },
      },
    });

    if (!restaurant) {
      return reply.code(404).send({ error: "restaurant_not_found" });
    }

    return {
      restaurant: {
        id: restaurant.id,
        name: restaurant.name,
        slug: restaurant.slug,
        description: restaurant.description,
        address: restaurant.address,
        city: restaurant.city,
        phone: restaurant.phone,
        email: restaurant.email,
        website: restaurant.website,
        coverImageUrl: restaurant.coverImageId ? `/api/media/${restaurant.coverImageId}` : null,
        logoUrl: restaurant.logoId ? `/api/media/${restaurant.logoId}` : null,
        acceptReservations: restaurant.acceptReservations,
        depositPerGuestCents: restaurant.depositPerGuestCents,
        menuItems: restaurant.menuItems.map((m) => ({
          ...m,
          photos: (restaurant as any).photos
            ?.filter((p: any) => p.menuItemId === m.id)
            .map((p: any) => ({ id: p.id, url: `/api/photo/${p.id}` })) ?? [],
        })),
        openingHours: restaurant.openingHours,
        photos: (restaurant as any).photos
          ?.filter((p: any) => !p.menuItemId)
          .map((p: any) => ({ id: p.id, url: `/api/photo/${p.id}` })) ?? [],
        servers: restaurant.servers,
      },
      reviews: {
        avgRating: null,
        count: 0,
        latest: [],
      },
    };
  });

  app.get("/r/:slug/availability", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { date } = z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(() => new Date().toISOString().split("T")[0]),
    }).parse(req.query ?? {});

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      include: { openingHours: true },
    });
    if (!restaurant) return reply.code(404).send({ error: "restaurant_not_found" });
    if (!(restaurant as any).acceptReservations) return { slots: [] };

    const d = new Date(date + "T12:00:00"); // noon to avoid TZ issues
    const dayOfWeek = d.getDay(); // 0=Sunday

    const dayHours = restaurant.openingHours.filter((h) => h.dayOfWeek === dayOfWeek);
    if (!dayHours.length) return { slots: [] };

    const slotMin: number = (restaurant as any).reservationSlotMinutes ?? 30;
    const leadMin: number = (restaurant as any).reservationLeadMinutes ?? 60;
    const mealMin: number = (restaurant as any).avgPrepMinutes ?? 90;

    const now = new Date();
    const slots: { date: string; time: string; available: boolean }[] = [];

    for (const period of dayHours) {
      let cur: number = period.openMin;
      const lastSlot = period.closeMin - mealMin;
      while (cur <= lastSlot) {
        const slotDate = new Date(date + "T00:00:00");
        slotDate.setHours(Math.floor(cur / 60), cur % 60, 0, 0);
        const time = `${String(Math.floor(cur / 60)).padStart(2, "0")}:${String(cur % 60).padStart(2, "0")}`;
        const available = slotDate.getTime() > now.getTime() + leadMin * 60_000;
        slots.push({ date, time, available });
        cur += slotMin;
      }
    }

    return { slots };
  });

  app.post("/r/:slug/reservations", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const input = z.object({
      name: z.string().min(1),
      phone: z.string(),
      email: z.string().email().optional(),
      date: z.string(), // ISO date
      time: z.string(), // HH:mm
      guests: z.number().int().min(1),
    }).parse(req.body);

    const restaurant = await prisma.restaurant.findUnique({
      where: { slug },
      select: { id: true, name: true, address: true, phone: true },
    });
    if (!restaurant) {
      return reply.code(404).send({ error: "restaurant_not_found" });
    }

    const [hours, mins] = input.time.split(":").map(Number);
    const startsAt = new Date(input.date);
    startsAt.setHours(hours, mins, 0, 0);

    const reservation = await prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        startsAt,
        partySize: input.guests,
        customerName: input.name,
        customerEmail: input.email ?? "",
        customerPhone: input.phone,
        status: "PENDING",
      },
    });

    // Send confirmation email if customer provided email + Resend is configured
    if (input.email && canSendEmail()) {
      const dateFormatted = startsAt.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
      const html = reservationConfirmationHtml({
        restaurantName: restaurant.name,
        customerName: input.name,
        date: dateFormatted,
        time: input.time,
        guests: input.guests,
        restaurantAddress: (restaurant as any).address ?? null,
        restaurantPhone: (restaurant as any).phone ?? null,
      });
      // Non-blocking — don't fail the request if email fails
      sendEmail({
        to: input.email,
        from: "reservations@matable.pro",
        subject: `Réservation confirmée · ${restaurant.name}`,
        html,
      }).catch(err => console.error("[email] reservation confirmation failed:", err));
    }

    return { ok: true, reservationId: reservation.id };
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

    // Compute expectedReadyAt: now + max(waitMinutes) across ordered items
    // waitMinutes is added via ensure_columns.sql, use raw query to read it
    const menuItemIds = body.items.map((i) => i.menuItemId);
    type WaitRow = { id: string; waitMinutes: number };
    let waitRows: WaitRow[] = [];
    if (menuItemIds.length > 0) {
      waitRows = await prisma.$queryRaw<WaitRow[]>`
        SELECT id, COALESCE("waitMinutes", 0)::int AS "waitMinutes"
        FROM "MenuItem" WHERE id = ANY(${menuItemIds}::text[])
      `;
    }
    const waitMap = new Map(waitRows.map((r) => [r.id, r.waitMinutes]));
    const maxWait = Math.max(0, ...body.items.map((i) => waitMap.get(i.menuItemId) ?? 0));
    const expectedReadyAt = maxWait > 0 ? new Date(Date.now() + maxWait * 60_000) : null;

    const order = await prisma.order.create({
      data: {
        tableId: decoded.tableId,
        sessionId: decoded.sessionId,
        items: lines,
        totalCents,
      },
      include: { table: true },
    });

    // Store expectedReadyAt via raw (column added by ensure_columns.sql)
    if (expectedReadyAt) {
      await prisma.$executeRaw`
        UPDATE "Order" SET "expectedReadyAt" = ${expectedReadyAt} WHERE id = ${order.id}
      `;
    }

    emitToRestaurant(decoded.restaurantId, "order:new", {
      id: order.id,
      tableId: order.tableId,
      tableNumber: order.table.number,
      items: lines,
      totalCents,
      createdAt: order.createdAt,
      status: order.status,
      expectedReadyAt,
    });

    return { orderId: order.id, totalCents, expectedReadyAt };
  });

  app.get("/orders/mine", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const orders = await prisma.order.findMany({
      where: { sessionId: decoded.sessionId },
      orderBy: { createdAt: "desc" },
    });

    // Attach expectedReadyAt from raw (column added by ensure_columns.sql)
    const ids = orders.map((o) => o.id);
    type EtaRow = { id: string; expectedReadyAt: Date | null };
    let etaRows: EtaRow[] = [];
    if (ids.length > 0) {
      etaRows = await prisma.$queryRaw<EtaRow[]>`
        SELECT id, "expectedReadyAt" FROM "Order" WHERE id = ANY(${ids}::text[])
      `;
    }
    const etaMap = new Map(etaRows.map((r) => [r.id, r.expectedReadyAt]));

    return {
      orders: orders.map((o) => ({
        ...o,
        expectedReadyAt: etaMap.get(o.id) ?? null,
      })),
    };
  });

  app.post("/bill/request", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const { mode } = z
      .object({ mode: z.enum(["CARD", "CASH", "COUNTER"]).default("CARD") })
      .parse(req.body ?? {});

    const session = await prisma.tableSession.findUnique({
      where: { id: decoded.sessionId },
      include: { table: true },
    });
    if (!session || !session.active) return reply.code(401).send({ error: "session_closed" });

    await prisma.tableSession.update({
      where: { id: decoded.sessionId },
      data: { billRequestedAt: new Date(), billPaymentMode: mode as any },
    });

    emitToRestaurant(decoded.restaurantId, "bill:requested", {
      tableId: decoded.tableId,
      tableNumber: session.table.number,
      mode,
    });

    return { ok: true };
  });

  // ── Tip ─────────────────────────────────────────────────────────────────────
  app.post("/tip", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const { amountCents } = z.object({ amountCents: z.number().int().min(50).max(50000) }).parse(req.body);

    const session = await prisma.tableSession.findUnique({ where: { id: decoded.sessionId } });
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    await prisma.tableSession.update({
      where: { id: decoded.sessionId },
      data: { tipCents: (session.tipCents ?? 0) + amountCents },
    });

    // Also credit the server if assigned
    if (session.serverId) {
      // Update any open orders to include tip (spread across latest order)
      const latestOrder = await prisma.order.findFirst({
        where: { sessionId: decoded.sessionId, status: { not: "CANCELLED" } },
        orderBy: { createdAt: "desc" },
      });
      if (latestOrder) {
        await prisma.order.update({
          where: { id: latestOrder.id },
          data: { tipCents: (latestOrder.tipCents ?? 0) + amountCents },
        });
      }
    }

    emitToRestaurant(decoded.restaurantId, "tip:received", {
      tableId: decoded.tableId,
      sessionId: decoded.sessionId,
      amountCents,
      serverId: session.serverId,
    });

    return { ok: true, totalTipCents: (session.tipCents ?? 0) + amountCents };
  });

  // ── Reviews ─────────────────────────────────────────────────────────────────
  app.post("/reviews", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const body = z.object({
      serverRating: z.number().int().min(1).max(5).optional(),
      serverComment: z.string().max(500).optional(),
      dishReviews: z.array(z.object({
        menuItemId: z.string(),
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(500).optional(),
      })).optional(),
    }).parse(req.body);

    const session = await prisma.tableSession.findUnique({ where: { id: decoded.sessionId } });
    if (!session) return reply.code(404).send({ error: "session_not_found" });

    // Find the latest order for this session
    const latestOrder = await prisma.order.findFirst({
      where: { sessionId: decoded.sessionId, status: { not: "CANCELLED" } },
      orderBy: { createdAt: "desc" },
    });

    // Server review
    if (body.serverRating && session.serverId) {
      await prisma.serverReview.create({
        data: {
          restaurantId: decoded.restaurantId,
          serverId: session.serverId,
          orderId: latestOrder?.id,
          rating: body.serverRating,
          comment: body.serverComment ?? null,
        },
      });
    }

    // Dish reviews
    if (body.dishReviews && body.dishReviews.length > 0) {
      for (const dr of body.dishReviews) {
        await prisma.dishReview.create({
          data: {
            restaurantId: decoded.restaurantId,
            menuItemId: dr.menuItemId,
            orderId: latestOrder?.id,
            rating: dr.rating,
            comment: dr.comment ?? null,
          },
        });
      }
    }

    return { ok: true };
  });

  // ── Service call ────────────────────────────────────────────────────────────
  app.post("/service-call", async (req, reply) => {
    const decoded = await requireSessionToken(req, reply);
    const { reason } = z.object({ reason: z.string().max(200).default("Appel serveur") }).parse(req.body ?? {});

    const table = await prisma.table.findUnique({ where: { id: decoded.tableId } });
    if (!table) return reply.code(404).send({ error: "table_not_found" });

    const call = await prisma.serviceCall.create({
      data: {
        restaurantId: decoded.restaurantId,
        tableId: decoded.tableId,
        sessionId: decoded.sessionId,
        reason,
      },
    });

    emitToRestaurant(decoded.restaurantId, "service:called", {
      id: call.id,
      tableId: decoded.tableId,
      tableNumber: table.number,
      reason,
    });

    return { ok: true, callId: call.id };
  });
}
