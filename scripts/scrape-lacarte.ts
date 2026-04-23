/**
 * Scraper lacarte.menu/restaurants
 *
 * Usage:
 *   npx tsx scripts/scrape-lacarte.ts [--pages 5] [--city paris] [--dry-run]
 *
 * Requires Playwright:
 *   npm install -D playwright && npx playwright install chromium
 *
 * Outputs:
 *   - data/prospects.csv   (pour git)
 *   - DB table Prospect    (pour l'admin)
 */

import { chromium } from "playwright";
import { PrismaClient } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ─── Config ──────────────────────────────────────────────────────────────────
const BASE_URL = "https://lacarte.menu/restaurants";
const CONCURRENCY = 2;
const DELAY_MS = 1500;
const args = process.argv.slice(2);
const MAX_PAGES = parseInt(args[args.indexOf("--pages") + 1] ?? "10") || 10;
const CITY_FILTER = args[args.indexOf("--city") + 1] ?? null;
const DRY_RUN = args.includes("--dry-run");

const prisma = new PrismaClient();

// ─── Types ────────────────────────────────────────────────────────────────────
interface ProspectData {
  name: string;
  city?: string;
  address?: string;
  phone?: string;
  email?: string;
  description?: string;
  website?: string;
  category?: string;
  imageUrl?: string;
  sourceUrl?: string;
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string, emoji = "▸") {
  console.log(`${emoji}  ${msg}`);
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// ─── CSV writer ───────────────────────────────────────────────────────────────
function toCSV(prospects: ProspectData[]): string {
  const headers = ["name", "city", "address", "phone", "email", "description", "website", "category", "imageUrl", "sourceUrl"];
  const escape = (v: string | undefined) => `"${(v ?? "").replace(/"/g, '""')}"`;
  return [
    headers.join(","),
    ...prospects.map((p) => headers.map((h) => escape((p as any)[h])).join(",")),
  ].join("\n");
}

// ─── Scraping ─────────────────────────────────────────────────────────────────
async function scrapeListPage(page: any, url: string): Promise<{ items: { name: string; url: string; city?: string; category?: string; imageUrl?: string }[]; nextUrl: string | null }> {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  await sleep(DELAY_MS);

  const items = await page.evaluate(() => {
    const results: any[] = [];

    // Try multiple selector patterns common to restaurant listing sites
    const selectors = [
      "a[href*='/restaurant']",
      ".restaurant-card a",
      ".listing-item a",
      "[data-restaurant] a",
      ".card a",
    ];

    let links: Element[] = [];
    for (const sel of selectors) {
      links = Array.from(document.querySelectorAll(sel));
      if (links.length > 2) break;
    }

    // Fallback: any links containing restaurant name patterns
    if (links.length < 2) {
      links = Array.from(document.querySelectorAll("a[href]")).filter((a) => {
        const href = (a as HTMLAnchorElement).href;
        return href.includes("/restaurant") || href.includes("/resto") || href.includes("/etablissement");
      });
    }

    const seen = new Set<string>();
    for (const link of links) {
      const a = link as HTMLAnchorElement;
      const href = a.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);

      // Extract name from various patterns
      const nameEl = a.querySelector("h2, h3, h4, .name, .title, [class*='name'], [class*='title']");
      const name = (nameEl?.textContent ?? a.textContent ?? "").trim();
      if (!name || name.length < 2) continue;

      // City
      const cityEl = a.querySelector(".city, .location, [class*='city'], [class*='location'], [class*='ville']");
      const city = cityEl?.textContent?.trim();

      // Category
      const catEl = a.querySelector(".category, .type, [class*='category'], [class*='type'], [class*='cuisine']");
      const category = catEl?.textContent?.trim();

      // Image
      const img = a.querySelector("img");
      const imageUrl = img?.src || img?.dataset?.src;

      results.push({ name, url: href, city, category, imageUrl });
    }
    return results;
  });

  // Detect next page
  const nextUrl = await page.evaluate(() => {
    const nextBtn = document.querySelector(
      'a[rel="next"], a[aria-label*="suivant"], a[aria-label*="next"], .pagination a:last-child, [class*="next"] a, [class*="pagination"] a:last-child'
    ) as HTMLAnchorElement | null;
    if (!nextBtn || !nextBtn.href) return null;
    // Make sure it's actually a next page (not the same URL)
    return nextBtn.href !== window.location.href ? nextBtn.href : null;
  }).catch(() => null);

  return { items, nextUrl };
}

async function scrapeDetailPage(page: any, url: string): Promise<Partial<ProspectData>> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await sleep(800);

    return await page.evaluate(() => {
      const text = (sel: string) => document.querySelector(sel)?.textContent?.trim() ?? undefined;
      const attr = (sel: string, a: string) => (document.querySelector(sel) as HTMLElement)?.getAttribute(a) ?? undefined;

      // Address
      const address =
        text('[class*="address"], [class*="adresse"], address, [itemprop="address"]') ??
        text('.location, [class*="location"]');

      // Phone
      const phoneEl = document.querySelector('a[href^="tel:"], [class*="phone"], [class*="tel"], [itemprop="telephone"]');
      const phone = phoneEl?.textContent?.trim().replace(/\s/g, "") ??
        (phoneEl as HTMLAnchorElement)?.href?.replace("tel:", "");

      // Email
      const emailEl = document.querySelector('a[href^="mailto:"], [class*="email"]') as HTMLAnchorElement | null;
      const email = emailEl?.href?.replace("mailto:", "") ?? emailEl?.textContent?.trim();

      // Description
      const description =
        text('[class*="description"], [class*="about"], [itemprop="description"], .bio, .intro') ??
        text('.content p, main p');

      // Website
      const websiteEl = document.querySelector('a[class*="website"], a[class*="site"], [itemprop="url"]') as HTMLAnchorElement | null;
      const website = websiteEl?.href;

      return { address, phone, email, description, website };
    });
  } catch {
    return {};
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log("🔍 Scraper lacarte.menu — démarrage", "🚀");
  if (DRY_RUN) log("Mode dry-run — aucune écriture en DB", "⚠️");

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    locale: "fr-FR",
    extraHTTPHeaders: { "Accept-Language": "fr-FR,fr;q=0.9" },
  });
  const listPage = await context.newPage();
  const detailPage = await context.newPage();

  const allProspects: ProspectData[] = [];
  let currentUrl: string | null = CITY_FILTER
    ? `${BASE_URL}?ville=${encodeURIComponent(CITY_FILTER)}`
    : BASE_URL;
  let pageNum = 0;
  let newCount = 0;
  let skipCount = 0;

  while (currentUrl && pageNum < MAX_PAGES) {
    pageNum++;
    log(`Page ${pageNum}/${MAX_PAGES} — ${currentUrl}`, "📄");

    const { items, nextUrl } = await scrapeListPage(listPage, currentUrl);
    log(`  → ${items.length} restaurants trouvés`);

    for (const item of items) {
      // Check if already in DB
      const existing = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) as count FROM "Prospect" WHERE "sourceUrl" = ${item.url}
      `;
      if (Number(existing[0]?.count) > 0) {
        skipCount++;
        continue;
      }

      // Scrape detail page
      const detail = await scrapeDetailPage(detailPage, item.url);
      await sleep(DELAY_MS);

      const prospect: ProspectData = {
        name: item.name,
        city: item.city ?? detail.address?.split(",").pop()?.trim(),
        address: detail.address,
        phone: detail.phone,
        email: detail.email,
        description: detail.description?.slice(0, 1000),
        website: detail.website,
        category: item.category,
        imageUrl: item.imageUrl,
        sourceUrl: item.url,
      };

      allProspects.push(prospect);
      newCount++;

      if (!DRY_RUN) {
        await prisma.$executeRaw`
          INSERT INTO "Prospect" (id, name, city, address, phone, email, description, website, category, "imageUrl", "sourceUrl", status, "createdAt", "updatedAt")
          VALUES (
            ${crypto.randomUUID()},
            ${prospect.name},
            ${prospect.city ?? null},
            ${prospect.address ?? null},
            ${prospect.phone ?? null},
            ${prospect.email ?? null},
            ${prospect.description ?? null},
            ${prospect.website ?? null},
            ${prospect.category ?? null},
            ${prospect.imageUrl ?? null},
            ${prospect.sourceUrl ?? null},
            'NEW',
            NOW(), NOW()
          )
          ON CONFLICT DO NOTHING
        `;
      }

      log(`  ✓ ${prospect.name} (${prospect.city ?? "?"}) — ${prospect.phone ?? "pas de tel"}`);
    }

    currentUrl = nextUrl;
    if (!nextUrl) {
      log("Fin de pagination détectée", "✅");
      break;
    }
  }

  await browser.close();
  await prisma.$disconnect();

  // Write CSV
  const dataDir = path.join(process.cwd(), "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const csvPath = path.join(dataDir, "prospects.csv");
  const existing = fs.existsSync(csvPath)
    ? fs.readFileSync(csvPath, "utf8").split("\n").slice(1) // skip header
    : [];

  const allLines = [
    "name,city,address,phone,email,description,website,category,imageUrl,sourceUrl",
    ...existing,
    ...allProspects.map((p) => {
      const esc = (v: string | undefined) => `"${(v ?? "").replace(/"/g, '""')}"`;
      return [p.name, p.city, p.address, p.phone, p.email, p.description, p.website, p.category, p.imageUrl, p.sourceUrl]
        .map((v) => esc(v as string | undefined))
        .join(",");
    }),
  ];

  fs.writeFileSync(csvPath, allLines.join("\n"), "utf8");

  console.log("\n" + "═".repeat(50));
  log(`Nouveaux : ${newCount}  |  Déjà en base : ${skipCount}  |  CSV : data/prospects.csv`, "📊");
  log(`Pour pousser sur git : git add data/prospects.csv && git commit -m "chore: update prospects"`, "💡");
  console.log("═".repeat(50));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
