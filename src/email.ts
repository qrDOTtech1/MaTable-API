/**
 * Centralized email helper — powered by Resend
 * All emails sent from @matable.pro domain
 */
import { Resend } from "resend";
import { env } from "./env.js";

let _resend: Resend | null = null;

function getResend(): Resend {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY non configuré");
  if (!_resend) _resend = new Resend(env.RESEND_API_KEY);
  return _resend;
}

export function canSendEmail(): boolean {
  return !!env.RESEND_API_KEY;
}

interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string; // defaults to notifications@matable.pro
  replyTo?: string;
}

export async function sendEmail(opts: SendEmailOptions): Promise<{ ok: boolean; id?: string; error?: string }> {
  if (!canSendEmail()) {
    console.warn("[email] RESEND_API_KEY not set — email not sent:", opts.subject);
    return { ok: false, error: "RESEND_API_KEY non configuré" };
  }
  try {
    const resend = getResend();
    const result = await resend.emails.send({
      from: opts.from ?? "notifications@matable.pro",
      to: Array.isArray(opts.to) ? opts.to : [opts.to],
      subject: opts.subject,
      html: opts.html,
      replyTo: opts.replyTo,
    });
    if (result.error) return { ok: false, error: result.error.message };
    return { ok: true, id: result.data?.id };
  } catch (e: any) {
    console.error("[email] send failed:", e?.message);
    return { ok: false, error: e?.message ?? "Erreur inconnue" };
  }
}

// ── Email templates ───────────────────────────────────────────────────────────

export function reservationConfirmationHtml(opts: {
  restaurantName: string;
  customerName: string;
  date: string;       // formatted date
  time: string;       // HH:mm
  guests: number;
  restaurantAddress?: string | null;
  restaurantPhone?: string | null;
  depositEur?: number;
}): string {
  return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8f8f8;font-family:sans-serif">
  <div style="max-width:540px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08)">
    <!-- Header -->
    <div style="background:#ea580c;padding:32px 32px 24px;text-align:center">
      <h1 style="color:#fff;margin:0;font-size:24px;font-weight:900">✅ Réservation confirmée !</h1>
      <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px">${opts.restaurantName}</p>
    </div>
    <!-- Body -->
    <div style="padding:32px">
      <p style="font-size:16px;color:#1a1a1a;margin:0 0 24px">
        Bonjour <strong>${opts.customerName}</strong>,<br>
        Votre table est réservée. Voici le récapitulatif :
      </p>
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#666;font-size:14px">📅 Date</td>
          <td style="padding:10px 0;font-weight:700;text-align:right;font-size:14px">${opts.date}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#666;font-size:14px">🕐 Heure</td>
          <td style="padding:10px 0;font-weight:700;text-align:right;font-size:14px">${opts.time}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#666;font-size:14px">👥 Couverts</td>
          <td style="padding:10px 0;font-weight:700;text-align:right;font-size:14px">${opts.guests} personne${opts.guests > 1 ? "s" : ""}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#666;font-size:14px">📍 Restaurant</td>
          <td style="padding:10px 0;font-weight:700;text-align:right;font-size:14px">${opts.restaurantName}</td>
        </tr>
        ${opts.restaurantAddress ? `<tr style="border-bottom:1px solid #f0f0f0"><td style="padding:10px 0;color:#666;font-size:14px">🗺 Adresse</td><td style="padding:10px 0;font-weight:700;text-align:right;font-size:14px">${opts.restaurantAddress}</td></tr>` : ""}
        ${opts.restaurantPhone ? `<tr><td style="padding:10px 0;color:#666;font-size:14px">📞 Téléphone</td><td style="padding:10px 0;font-weight:700;text-align:right;font-size:14px">${opts.restaurantPhone}</td></tr>` : ""}
      </table>
      ${opts.depositEur ? `<div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#9a3412">💳 Arrhes prélevées : <strong>${opts.depositEur} €</strong> (déduits de votre addition)</div>` : ""}
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;font-size:13px;color:#166534">
        Annulation gratuite jusqu'à <strong>24h avant</strong> votre réservation.<br>
        Pour modifier ou annuler, contactez directement le restaurant.
      </div>
    </div>
    <!-- Footer -->
    <div style="background:#f8f8f8;padding:16px 32px;text-align:center;font-size:11px;color:#999">
      Envoyé via <strong>MaTable.Pro</strong> · matable.pro
    </div>
  </div>
</body>
</html>`;
}

export function voucherCodeHtml(opts: {
  restaurantName: string;
  code: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8f8f8;font-family:sans-serif">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08)">
    <div style="background:#ea580c;padding:32px 32px 24px;text-align:center">
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:900">Votre code de vérification</h1>
      <p style="color:rgba(255,255,255,0.85);margin:8px 0 0;font-size:14px">${opts.restaurantName}</p>
    </div>
    <div style="padding:40px 32px;text-align:center">
      <p style="font-size:15px;color:#333;margin:0 0 24px">Saisissez ce code pour obtenir votre récompense :</p>
      <div style="background:#f8f8f8;border:2px dashed #ea580c;border-radius:12px;padding:20px;display:inline-block">
        <span style="font-family:monospace;font-size:36px;font-weight:900;letter-spacing:8px;color:#ea580c">${opts.code}</span>
      </div>
      <p style="font-size:12px;color:#999;margin:24px 0 0">Ce code expire dans 10 minutes.</p>
    </div>
    <div style="background:#f8f8f8;padding:14px 32px;text-align:center;font-size:11px;color:#999">
      Envoyé via <strong>MaTable.Pro</strong> · matable.pro
    </div>
  </div>
</body>
</html>`;
}

export function invoiceHtml(opts: {
  restaurantName: string;
  restaurantAddress?: string | null;
  restaurantPhone?: string | null;
  tableNumber: number;
  tableZone?: string | null;
  date: string;
  paymentMode?: string | null;
  lines: { name: string; quantity: number; priceCents: number }[];
  subtotalCents: number;
  tipCents: number;
  totalCents: number;
  invoiceUrl?: string;
}): string {
  const fmt = (c: number) => (c / 100).toFixed(2) + " €";
  const modeLabel: Record<string, string> = { CARD: "Carte bancaire", CASH: "Espèces", COUNTER: "Caisse" };

  const lineRows = opts.lines.map(l =>
    `<tr>
      <td style="padding:6px 0;font-size:13px">${l.quantity}× ${l.name}</td>
      <td style="padding:6px 0;font-size:13px;text-align:right">${fmt(l.quantity * l.priceCents)}</td>
    </tr>`
  ).join("");

  return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8f8f8;font-family:monospace">
  <div style="max-width:480px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08)">
    <div style="background:#1a1a1a;padding:28px 28px 20px;text-align:center">
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:900">${opts.restaurantName}</h1>
      ${opts.restaurantAddress ? `<p style="color:rgba(255,255,255,0.5);margin:4px 0 0;font-size:12px">${opts.restaurantAddress}</p>` : ""}
      ${opts.restaurantPhone ? `<p style="color:rgba(255,255,255,0.5);margin:2px 0 0;font-size:12px">${opts.restaurantPhone}</p>` : ""}
      <p style="color:#ea580c;margin:8px 0 0;font-size:11px;letter-spacing:2px;text-transform:uppercase">Ticket de caisse</p>
    </div>
    <div style="padding:24px 28px">
      <table style="width:100%;margin-bottom:16px;font-size:13px">
        <tr><td style="color:#666">Table</td><td style="text-align:right;font-weight:700">N° ${opts.tableNumber}${opts.tableZone ? ` · ${opts.tableZone}` : ""}</td></tr>
        <tr><td style="color:#666">Date</td><td style="text-align:right;font-weight:700">${opts.date}</td></tr>
        ${opts.paymentMode ? `<tr><td style="color:#666">Règlement</td><td style="text-align:right;font-weight:700">${modeLabel[opts.paymentMode] ?? opts.paymentMode}</td></tr>` : ""}
      </table>
      <hr style="border:none;border-top:1px dashed #ddd;margin:16px 0"/>
      <table style="width:100%;border-collapse:collapse">
        ${lineRows}
      </table>
      <hr style="border:none;border-top:1px dashed #ddd;margin:16px 0"/>
      <table style="width:100%;font-size:13px">
        <tr><td style="color:#666;padding:4px 0">Sous-total</td><td style="text-align:right;padding:4px 0">${fmt(opts.subtotalCents)}</td></tr>
        ${opts.tipCents > 0 ? `<tr><td style="color:#666;padding:4px 0">Pourboire</td><td style="text-align:right;padding:4px 0;color:#ea580c">+ ${fmt(opts.tipCents)}</td></tr>` : ""}
        <tr style="font-size:16px;font-weight:900"><td style="padding:8px 0 0">TOTAL</td><td style="text-align:right;padding:8px 0 0;color:#ea580c">${fmt(opts.totalCents)}</td></tr>
      </table>
      ${opts.invoiceUrl ? `<div style="margin-top:20px;text-align:center"><a href="${opts.invoiceUrl}" style="display:inline-block;background:#ea580c;color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:700">📄 Voir le ticket en ligne</a></div>` : ""}
    </div>
    <div style="background:#f8f8f8;padding:14px 28px;text-align:center;font-size:11px;color:#999">
      Merci de votre visite · <strong>MaTable.Pro</strong> · matable.pro
    </div>
  </div>
</body>
</html>`;
}

export function receiptWithLoyaltyHtml(opts: {
  restaurantName: string;
  customerName: string | null;
  totalEur: string;
  items: Array<{ name: string; qty: number; unitEur: string }>;
  loyalty: {
    points: number;
    earned: number;
    tier: string;
    nextTier: string | null;
    ptsToNext: number | null;
    cardUrl: string;
  } | null;
  date: string;
}): string {
  const TIER_ICONS: Record<string, string> = { bronze: "🥉", silver: "🥈", gold: "🥇", platinum: "💎" };
  const tierIcon = opts.loyalty ? (TIER_ICONS[opts.loyalty.tier] ?? "⭐") : "";

  const itemsHtml = opts.items.map(i => `
    <tr>
      <td style="padding:6px 0;font-size:14px;color:#333">${i.name}</td>
      <td style="padding:6px 0;font-size:14px;color:#666;text-align:center">×${i.qty}</td>
      <td style="padding:6px 0;font-size:14px;color:#333;text-align:right">${i.unitEur} €</td>
    </tr>`).join("");

  const loyaltyBlock = opts.loyalty ? `
    <div style="margin-top:24px;background:linear-gradient(135deg,#1a0a00,#2d1500);border-radius:16px;padding:20px 24px;color:#fff">
      <p style="margin:0 0 4px;font-size:12px;color:#f97316;font-weight:700;letter-spacing:.08em;text-transform:uppercase">Fidélité ${tierIcon} ${opts.loyalty.tier.charAt(0).toUpperCase() + opts.loyalty.tier.slice(1)}</p>
      <p style="margin:0 0 12px;font-size:22px;font-weight:900;color:#fff">+${opts.loyalty.earned} pts gagnés !</p>
      <p style="margin:0 0 4px;font-size:14px;color:rgba(255,255,255,.7)">Total accumulé : <strong style="color:#fff">${opts.loyalty.points.toLocaleString("fr-FR")} pts</strong></p>
      ${opts.loyalty.ptsToNext !== null ? `<p style="margin:0 0 16px;font-size:12px;color:rgba(255,255,255,.5)">Plus que ${opts.loyalty.ptsToNext.toLocaleString("fr-FR")} pts pour atteindre ${opts.loyalty.nextTier}</p>` : `<p style="margin:0 0 16px;font-size:12px;color:#a78bfa">✨ Niveau maximum — vous bénéficiez de tous les avantages !</p>`}
      <a href="${opts.loyalty.cardUrl}" style="display:inline-block;background:#f97316;color:#fff;font-weight:700;font-size:13px;padding:10px 20px;border-radius:10px;text-decoration:none">Voir ma carte fidélité →</a>
    </div>` : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:sans-serif">
  <div style="max-width:520px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.08)">
    <div style="background:#ea580c;padding:24px 32px;text-align:center">
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:900">${opts.restaurantName} · Merci !</h1>
      <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:13px">${opts.date}</p>
    </div>
    <div style="padding:24px 32px">
      ${opts.customerName ? `<p style="color:#555;font-size:14px;margin:0 0 16px">Bonjour <strong>${opts.customerName}</strong>,</p>` : ""}
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="border-bottom:2px solid #f0f0f0">
            <th style="text-align:left;padding:8px 0;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.05em">Article</th>
            <th style="text-align:center;padding:8px 0;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.05em">Qté</th>
            <th style="text-align:right;padding:8px 0;font-size:11px;color:#999;text-transform:uppercase;letter-spacing:.05em">Prix</th>
          </tr>
        </thead>
        <tbody>${itemsHtml}</tbody>
        <tfoot>
          <tr style="border-top:2px solid #f0f0f0">
            <td colspan="2" style="padding:12px 0;font-weight:900;font-size:16px;color:#111">Total</td>
            <td style="padding:12px 0;font-weight:900;font-size:16px;color:#ea580c;text-align:right">${opts.totalEur} €</td>
          </tr>
        </tfoot>
      </table>
      ${loyaltyBlock}
      <p style="margin:24px 0 0;font-size:11px;color:#bbb;text-align:center">Ticket généré par MaTable.pro</p>
    </div>
  </div>
</body>
</html>`.replace("${restaurantName}", opts.restaurantName);
}

export function contactFormHtml(opts: {
  restaurantName: string;
  managerName: string;
  email: string;
  message: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f8f8f8;font-family:sans-serif">
  <div style="max-width:540px;margin:32px auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,0.08)">
    <div style="background:#ea580c;padding:24px 32px;text-align:center">
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:900">Nouveau contact Landing Page</h1>
    </div>
    <div style="padding:32px">
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#666;font-size:14px;width:120px">Établissement</td>
          <td style="padding:10px 0;font-weight:700;font-size:14px">${opts.restaurantName}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#666;font-size:14px">Contact</td>
          <td style="padding:10px 0;font-weight:700;font-size:14px">${opts.managerName}</td>
        </tr>
        <tr style="border-bottom:1px solid #f0f0f0">
          <td style="padding:10px 0;color:#666;font-size:14px">Email</td>
          <td style="padding:10px 0;font-weight:700;font-size:14px"><a href="mailto:${opts.email}" style="color:#ea580c;text-decoration:none">${opts.email}</a></td>
        </tr>
      </table>
      <div style="background:#fff7ed;border-left:4px solid #ea580c;padding:16px;font-size:14px;line-height:1.6;color:#9a3412;white-space:pre-wrap">${opts.message}</div>
    </div>
  </div>
</body>
</html>`;
}
