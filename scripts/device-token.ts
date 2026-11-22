import "dotenv/config";
import { db } from "../src/lib/db";
import { createDeviceToken } from "../src/lib/auth/device-token";
import { normalizeEmail } from "../src/lib/auth/tokens";

/**
 * Sign a phone in by hand, until the app can do it itself by email:
 *
 *   docker compose exec app ./node_modules/.bin/tsx scripts/device-token.ts someone@example.com "Pixel 9"
 *
 * Prints the token once; it is pasted into the app. `--list` shows a member's phones, `--revoke <id-prefix>` signs
 * one out.
 */
async function main() {
  const [emailArg, ...rest] = process.argv.slice(2);
  if (!emailArg) throw new Error('Usage: tsx scripts/device-token.ts <email> ["phone name" | --list | --revoke <id-prefix>]');
  const user = await db.user.findUnique({ where: { email: normalizeEmail(emailArg) }, select: { id: true, email: true, removingAt: true } });
  if (!user || user.removingAt) throw new Error(`No member with the address ${emailArg}.`);
  if (rest[0] === "--list") {
    const rows = await db.deviceToken.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    if (!rows.length) console.log("No phones signed in.");
    for (const r of rows) console.log(`${r.id.slice(0, 12)}  ${r.name}  made ${r.createdAt.toISOString().slice(0, 10)}  last used ${r.lastUsedAt.toISOString().slice(0, 10)}`);
    return;
  }
  if (rest[0] === "--revoke") {
    const prefix = rest[1] ?? "";
    if (prefix.length < 8) throw new Error("Give at least the first 8 characters of the id, as --list shows it.");
    const { count } = await db.deviceToken.deleteMany({ where: { userId: user.id, id: { startsWith: prefix } } });
    console.log(count ? `Signed out ${count} phone(s).` : "No phone of theirs has that id.");
    return;
  }
  const { token } = await createDeviceToken(db, user.id, rest[0]);
  console.log(`Token for ${user.email} (shown once; paste it into the app):\n\n${token}\n`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
