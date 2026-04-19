import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const restaurant = await prisma.restaurant.upsert({
    where: { id: "demo-restaurant" },
    update: {},
    create: { id: "demo-restaurant", name: "Bistrot Démo" },
  });

  const passwordHash = await bcrypt.hash("demo1234", 10);
  await prisma.user.upsert({
    where: { email: "demo@atable.fr" },
    update: {},
    create: {
      email: "demo@atable.fr",
      passwordHash,
      restaurantId: restaurant.id,
    },
  });

  for (let n = 1; n <= 5; n++) {
    await prisma.table.upsert({
      where: { restaurantId_number: { restaurantId: restaurant.id, number: n } },
      update: {},
      create: { number: n, restaurantId: restaurant.id },
    });
  }

  const items = [
    { name: "Burger maison", priceCents: 1400, category: "Plats" },
    { name: "Salade César", priceCents: 1200, category: "Plats" },
    { name: "Frites", priceCents: 500, category: "Accompagnements" },
    { name: "Tiramisu", priceCents: 700, category: "Desserts" },
    { name: "Coca 33cl", priceCents: 350, category: "Boissons" },
  ];

  for (const it of items) {
    await prisma.menuItem.upsert({
      where: { id: `seed-${it.name}` },
      update: {},
      create: { id: `seed-${it.name}`, restaurantId: restaurant.id, ...it },
    });
  }

  console.log("Seed OK");
  console.log("Login pro : demo@atable.fr / demo1234");
  const tables = await prisma.table.findMany({ where: { restaurantId: restaurant.id } });
  for (const t of tables) {
    console.log(`  Table ${t.number} → /order/${t.id}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
