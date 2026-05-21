// Quantity TIERS — nouvelle approche : le client choisit explicitement un palier
// "qte / prix total pour cette quantite" dans la card du plat.
//
// Stored as JSONB on MenuItem.quantityTiers:
//   [
//     { "qty": 1, "priceCents": 800 },
//     { "qty": 3, "priceCents": 2200 },
//     { "qty": 6, "priceCents": 4000 }
//   ]
//
// Coexiste avec l'ancien champ quantityDiscounts (% de remise) — pas d'ecrasement.

export type QuantityTier = {
  qty: number;
  priceCents: number;
};

/** Parse + sanitize tiers depuis un JSON brut (contenu DB non-tiers). */
export function parseQuantityTiers(raw: unknown): QuantityTier[] {
  if (!Array.isArray(raw)) return [];
  const out: QuantityTier[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const qty = Number((t as any).qty);
    const priceCents = Number((t as any).priceCents);
    if (!Number.isFinite(qty) || qty < 1 || qty > 9999) continue;
    if (!Number.isFinite(priceCents) || priceCents < 0 || priceCents > 1_000_000) continue;
    out.push({ qty: Math.floor(qty), priceCents: Math.round(priceCents) });
  }
  // Tri croissant par qty pour affichage stable
  out.sort((a, b) => a.qty - b.qty);
  // Deduplication sur qty (on garde le 1er trouve)
  const seen = new Set<number>();
  return out.filter(t => {
    if (seen.has(t.qty)) return false;
    seen.add(t.qty);
    return true;
  });
}

/**
 * Calcule le prix TOTAL (cents) pour une commande de N unites donnees,
 * en respectant les paliers explicitement choisis par le restaurateur.
 *
 * Regle : on cherche le palier EXACT correspondant a la quantite demandee.
 * Si pas de match exact, on prend le palier le plus proche INFERIEUR ou egal,
 * puis on facture le reste au prix unitaire de base (basePriceCents).
 *
 * Ex avec tiers = [{qty:1,800}, {qty:3,2200}, {qty:6,4000}]
 *   qty=1 → 800
 *   qty=2 → 1600 (2× le palier qty=1)
 *   qty=3 → 2200 (palier exact)
 *   qty=4 → 3000 (palier qty=3 + 1× palier qty=1)
 *   qty=6 → 4000 (palier exact)
 *   qty=8 → 5600 (palier qty=6 + 2× palier qty=1)
 */
export function priceForQuantity(
  basePriceCents: number,
  quantity: number,
  tiers: QuantityTier[]
): number {
  if (quantity <= 0) return 0;
  if (tiers.length === 0) return basePriceCents * quantity;

  // Cherche un palier qui couvre exactement la quantite
  const exact = tiers.find(t => t.qty === quantity);
  if (exact) return exact.priceCents;

  // Sinon, decoupe en plus gros paliers possibles (gloutonne)
  let remaining = quantity;
  let total = 0;
  // Tiers triees decroissant pour glouton
  const desc = [...tiers].sort((a, b) => b.qty - a.qty);

  for (const t of desc) {
    if (remaining >= t.qty && t.qty > 0) {
      const n = Math.floor(remaining / t.qty);
      total += n * t.priceCents;
      remaining -= n * t.qty;
    }
  }

  // Reste au prix unitaire de base (fallback)
  if (remaining > 0) total += remaining * basePriceCents;
  return total;
}
