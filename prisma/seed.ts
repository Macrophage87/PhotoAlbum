import "dotenv/config";
import { db } from "../src/lib/db";

async function main() {
  const adminEmail = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const admin = await db.user.upsert({
    where: { email: adminEmail },
    update: { role: "ADMIN" },
    create: { email: adminEmail, name: "Admin", role: "ADMIN" },
  });
  console.log(`admin: ${admin.email}`);

  const trip = await db.trip.upsert({
    where: { slug: "acadia-maine" },
    update: {},
    create: {
      slug: "acadia-maine",
      title: "Acadia, Maine",
      description: "A week of lighthouses, lobster rolls and carriage-road rides on Mount Desert Island.",
      startDate: new Date("2025-08-10"),
      endDate: new Date("2025-08-16"),
      timezone: "America/New_York",
      themeKey: "lighthouse",
      createdById: admin.id,
    },
  });
  console.log(`trip: ${trip.slug}`);
}

main()
  .then(() => db.$disconnect())
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
