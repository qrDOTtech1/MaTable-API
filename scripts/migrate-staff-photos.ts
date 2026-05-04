/**
 * One-shot migration: mark existing server portrait photos as kind="STAFF"
 *
 * These photos were uploaded via POST /servers/:id/photo but saved with the
 * default kind="RESTAURANT", causing them to appear on the public restaurant page.
 *
 * Run once via:  railway run npx ts-node scripts/migrate-staff-photos.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Find all Photo records whose URL is referenced by a Server.photoUrl
  const servers = await prisma.server.findMany({
    where: { photoUrl: { not: null } },
    select: { id: true, name: true, restaurantId: true, photoUrl: true },
  });

  console.log(`Found ${servers.length} server(s) with a photoUrl`);

  let updated = 0;

  for (const server of servers) {
    if (!server.photoUrl) continue;

    // photoUrl is stored as "/api/photo/<uuid>"
    const match = server.photoUrl.match(/\/api\/photo\/([a-f0-9-]+)/i);
    if (!match) {
      console.log(`  [SKIP] ${server.name}: unrecognised photoUrl format: ${server.photoUrl}`);
      continue;
    }

    const photoId = match[1];

    const result = await prisma.photo.updateMany({
      where: { id: photoId, kind: { not: "STAFF" } },
      data: { kind: "STAFF" },
    });

    if (result.count > 0) {
      console.log(`  [FIXED] ${server.name} (${server.restaurantId}): photo ${photoId} → STAFF`);
      updated += result.count;
    } else {
      console.log(`  [OK]    ${server.name}: already STAFF or not found`);
    }
  }

  console.log(`\nDone. ${updated} photo(s) updated to kind="STAFF".`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
