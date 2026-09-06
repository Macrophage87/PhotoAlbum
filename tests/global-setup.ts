import "dotenv/config";
import { spawnSync } from "node:child_process";
import { testDatabaseUrl } from "./db-url";

/** Runs once before the unit tests: bring the *_test database up to date (created if missing). */
export default function globalSetup() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to run the unit tests");
  const url = testDatabaseUrl(process.env.DATABASE_URL);
  const res = spawnSync("./node_modules/.bin/prisma", ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "inherit",
  });
  if (res.status !== 0) throw new Error(`prisma migrate deploy failed for ${url.replace(/:[^:@/]+@/, ":***@")}`);
}
