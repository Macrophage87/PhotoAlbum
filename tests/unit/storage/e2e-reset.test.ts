import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** The e2e suite empties the database under a running server; its album must still be one album with its storage. */
const root = mkdtempSync(path.join(tmpdir(), "e2e-reset-"));
process.env.PHOTO_STORAGE_ROOT = root;
process.env.E2E_PHOTO_ROOT = root;
// The e2e helpers' reset, run against this suite's own database.
process.env.E2E_DATABASE_URL = process.env.DATABASE_URL;

it("leaves the database and the storage root one album's, however the root was left", async () => {
  const { resetDb } = await import("../../e2e/helpers");
  const { ensureInstallIdentity, installIdentity } = await import("@/lib/storage/identity");
  const { db } = await import("@/lib/db");
  // The server starts on an empty root, then the suite resets the database.
  await db.appSetting.deleteMany();
  expect((await ensureInstallIdentity()).ok).toBe(true);
  await resetDb();
  expect((await installIdentity()).ok).toBe(true);
  // A later run: photos from earlier runs whose rows the reset took, and the server starting again.
  mkdirSync(path.join(root, "photos", "cabcdefghijkl000000000001"), { recursive: true });
  writeFileSync(path.join(root, "photos", "cabcdefghijkl000000000001", "original.jpg"), "x");
  await resetDb();
  expect((await ensureInstallIdentity()).ok).toBe(true);
  // A root whose marker went missing.
  rmSync(path.join(root, ".album-install-id"));
  await resetDb();
  expect((await installIdentity()).ok).toBe(true);
});
