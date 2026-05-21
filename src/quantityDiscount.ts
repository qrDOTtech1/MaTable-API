// Quantity discount tiers — stored as JSONB on MenuItem.quantityDiscounts.
// Applied tier = the one with the highest minQty <= ordered quantity.

export type QuantityDiscount = {
  minQty: number;
  type: "PERCENT" | "FIXED_CENTS";
  value: number; // % (0-100) for PERCENT, cents off per unit for FIXED_CENTS
};

/** Parse + sanitize tiers from a raw JSON value (untrusted DB content). */
export function parseQuantityDiscounts(raw: unknown): QuantityDiscount[] {
  if (!Array.isArray(raw)) return [];
  const out: QuantityDiscount[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const minQty = Number((t as any).minQty);
    const value = Number((t as any).value);
    const type = (t as any).type;
    if (!Number.isFinite(minQty) || minQty < 2) continue;
    if (!Number.isFinite(value) || value < 0) continue;
    if (type !== "PERCENT" && type !== "FIXED_CENTS") continue;
    if (type === "PERCENT" && value > 100) continue;
    out.push({ minQty: Math.floor(minQty), type, value });
  }
  // Sort ascending by minQty for predictability
  out.sort((a, b) => a.minQty - b.minQty);
  return out;
}

/** Compute the effective unit price (cents) for a given quantity. */
export function effectiveUnitPriceCents(
  basePriceCents: number,
  quantity: number,
  tiers: QuantityDiscount[]
): number {
  if (quantity < 1 || tiers.length === 0) return basePriceCents;
  // Highest minQty that the quantity satisfies
  let applied: QuantityDiscount | null = null;
  for (const t of tiers) {
    if (quantity >= t.minQty) applied = t;
    else break; // tiers sorted ascending
  }
  if (!applied) return basePriceCents;
  if (applied.type === "PERCENT") {
    return Math.max(0, Math.round(basePriceCents * (1 - applied.value / 100)));
  }
  return Math.max(0, basePriceCents - applied.value);
}
