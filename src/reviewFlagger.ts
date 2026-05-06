/**
 * Negative keyword detector for customer reviews.
 *
 * Scans review text + comments to detect complaints categories.
 * Used to:
 *  - flag reviews in the dashboard with a red alert
 *  - aggregate recurring complaints in /api/pro/reviews/insights
 */

export type FlagCategory =
  | "hygiene"           // sale, sale, mouches, sale, propreté
  | "temperature"       // froid, tiede, pas chaud
  | "service_lent"      // attente, lent, oublié, jamais venu
  | "service_accueil"   // mal accueilli, désagréable, méprisant
  | "qualite_plat"      // mauvais, immangeable, mal cuit, pas frais
  | "rapport_qualite"   // cher, arnaque, pas le prix
  | "ambiance"          // bruit, sale, inconfortable
  | "autre";

const KEYWORD_MAP: { category: FlagCategory; keywords: string[] }[] = [
  {
    category: "hygiene",
    keywords: ["sale", "sales", "saleté", "saletes", "saletés", "crasse", "crade", "crado", "mouche", "mouches", "cafard", "insecte", "tache", "taché", "non propre", "pas propre", "dégoutant", "degoutant", "dégueulasse", "degueulasse", "porc"],
  },
  {
    category: "temperature",
    keywords: ["froid", "froide", "tiède", "tiede", "tièdes", "tiedes", "pas chaud", "pas chaude", "réchauffé", "rechauffé", "refroidi"],
  },
  {
    category: "service_lent",
    keywords: ["attente", "attendu", "attendre", "long temps", "trop long", "lent", "lente", "lents", "oublié", "oubliée", "oublies", "jamais venu", "personne", "n'est venu", "ignoré", "ignorée", "sans réponse", "patienter", "interminable"],
  },
  {
    category: "service_accueil",
    keywords: ["mal accueilli", "mauvais accueil", "désagréable", "desagreable", "méprisant", "meprisant", "impoli", "grossier", "grossière", "agressif", "rude", "froid avec moi", "antipathique", "indifférent", "indifferent", "snob", "hautain", "désintéressé", "desinteressé", "pas aimable"],
  },
  {
    category: "qualite_plat",
    keywords: ["immangeable", "imbuvable", "mauvais", "mauvaise", "raté", "ratée", "rate", "ratee", "mal cuit", "trop cuit", "pas cuit", "saignant", "carbonisé", "carbonise", "brulé", "brule", "pas frais", "périmé", "perimé", "perimée", "fade", "insipide", "sans saveur", "sans goût", "sans gout", "écœurant", "ecoeurant", "écoeurant", "pas bon", "vraiment pas bon", "déçu par le plat", "decu par le plat", "trop salé", "trop sale", "trop sucré", "trop sucre", "trop poivré", "ranci", "pourri"],
  },
  {
    category: "rapport_qualite",
    keywords: ["trop cher", "trop chère", "trop chers", "arnaque", "voler", "volé", "vol", "abusé", "abuse", "exagéré", "exagere", "rapport qualité prix", "rapport qualité-prix", "pas le prix", "pas à ce prix", "scandaleux", "ce n'est pas donné"],
  },
  {
    category: "ambiance",
    keywords: ["bruit", "bruyant", "bruyante", "trop bruyant", "trop fort", "musique trop forte", "ambiance bof", "ambiance pourrie", "tristounet", "tristoun", "inconfortable", "froid dans la salle", "pas convivial"],
  },
];

const FLAG_CATEGORY_LABELS: Record<FlagCategory, string> = {
  hygiene: "Hygiène",
  temperature: "Température",
  service_lent: "Lenteur du service",
  service_accueil: "Accueil",
  qualite_plat: "Qualité du plat",
  rapport_qualite: "Rapport qualité/prix",
  ambiance: "Ambiance",
  autre: "Autre",
};

export function getFlagCategoryLabel(cat: string): string {
  return FLAG_CATEGORY_LABELS[cat as FlagCategory] ?? cat;
}

/**
 * Normalize a string for matching: lowercase, no accents, single spaces.
 */
function normalize(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detect flag categories triggered by the given text.
 * Always returns a structured result; empty arrays = no flag.
 */
export function detectFlags(...texts: (string | null | undefined)[]): {
  flagged: boolean;
  reasons: string[];
  matched: { category: FlagCategory; keyword: string }[];
} {
  const blob = normalize(texts.filter(Boolean).join(" \n "));
  if (!blob) return { flagged: false, reasons: [], matched: [] };

  const matched: { category: FlagCategory; keyword: string }[] = [];
  const seenCategories = new Set<FlagCategory>();

  for (const { category, keywords } of KEYWORD_MAP) {
    for (const kw of keywords) {
      const needle = normalize(kw);
      if (!needle) continue;
      // Word boundary-ish: ensure surrounded by non-word chars or string boundaries.
      const re = new RegExp(`(^|\\s)${needle.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&")}(\\s|$)`);
      if (re.test(blob)) {
        matched.push({ category, keyword: kw });
        seenCategories.add(category);
        break; // 1 match per category is enough
      }
    }
  }

  return {
    flagged: matched.length > 0,
    reasons: Array.from(seenCategories),
    matched,
  };
}

/**
 * Heuristic: a low rating (<= 2) AND no detected keywords still deserves a flag
 * with a generic "low_rating" reason, because the customer is unhappy but
 * didn't articulate why.
 */
export function detectFlagsWithRating(
  rating: number | null | undefined,
  ...texts: (string | null | undefined)[]
): { flagged: boolean; reasons: string[] } {
  const base = detectFlags(...texts);
  if (base.flagged) return { flagged: true, reasons: base.reasons };
  if (typeof rating === "number" && rating > 0 && rating <= 2) {
    return { flagged: true, reasons: ["note_basse"] };
  }
  return { flagged: false, reasons: [] };
}
