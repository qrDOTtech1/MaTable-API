/**
 * App Gating — modular app system for MaTable.
 *
 * Each restaurant has an `enabledApps` JSONB column (array of app IDs).
 * Admin toggles apps on/off per restaurant via MaTableAdmin.
 *
 * App IDs:
 *   - "reviews"       → Avis Google & Reputation (base app)
 *   - "reservations"  → Reservations en ligne
 *   - "orders"        → Commandes QR code + Service calls + Tips
 *   - "nova_ia"       → Nova IA (chatbot, magic-scan, menu generator, pairings)
 *   - "nova_stock"    → Nova Stock IA (stock analysis, shopping lists)
 *   - "nova_contab"   → Nova Contab IA (comptabilite)
 *   - "nova_finance"  → Nova Finance IA (financial advice, promotions)
 */
import { prisma } from "./db.js";

/** All known app IDs */
export const APP_IDS = [
  "reviews",
  "reservations",
  "orders",
  "nova_ia",
  "nova_stock",
  "nova_contab",
  "nova_finance",
] as const;

export type AppId = (typeof APP_IDS)[number];

/** App metadata for display in admin panel */
export const APP_CATALOG: Record<AppId, { name: string; description: string; price: number; category: string }> = {
  reviews:       { name: "Avis Google & Reputation",  description: "QR code avis, chatbot IA, vouchers",              price: 4599, category: "base" },
  reservations:  { name: "Reservations en ligne",     description: "Booking, creneaux, confirmation email",           price: 2999, category: "feature" },
  orders:        { name: "Commandes & Service",       description: "QR commandes, appels serveur, pourboires, caisse", price: 3999, category: "feature" },
  nova_ia:       { name: "Nova IA",                   description: "Chatbot, Magic Scan, generateur menu, accords",   price: 4999, category: "ia" },
  nova_stock:    { name: "Nova Stock IA",             description: "Analyse stock, listes de courses, alertes",        price: 3999, category: "ia" },
  nova_contab:   { name: "Nova Contab IA",            description: "Comptabilite IA, rapports, export",               price: 3999, category: "ia" },
  nova_finance:  { name: "Nova Finance IA",           description: "Conseils financiers, promotions, anti-gaspillage", price: 2999, category: "ia" },
};

/**
 * Fetch the enabledApps array for a restaurant.
 * Returns a Set<string> for O(1) lookups.
 */
export async function getEnabledApps(restaurantId: string): Promise<Set<string>> {
  const rows = await prisma.$queryRawUnsafe<Array<{ enabledApps: unknown }>>(
    `SELECT "enabledApps" FROM "Restaurant" WHERE id = $1 LIMIT 1`,
    restaurantId,
  );
  const raw = rows[0]?.enabledApps;
  if (Array.isArray(raw)) return new Set(raw as string[]);
  return new Set(["reviews"]); // fallback
}

/**
 * Check if a restaurant has a specific app enabled.
 * Use this in route handlers instead of `subscription !== "PRO_IA"`.
 */
export async function hasApp(restaurantId: string, app: AppId): Promise<boolean> {
  const apps = await getEnabledApps(restaurantId);
  return apps.has(app);
}

/**
 * Check if a restaurant has ANY of the given apps enabled.
 */
export async function hasAnyApp(restaurantId: string, ...apps: AppId[]): Promise<boolean> {
  const enabled = await getEnabledApps(restaurantId);
  return apps.some((a) => enabled.has(a));
}
