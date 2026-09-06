/* Starts the standalone production build on port 3200 with the e2e database and a scratch photo dir. */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import "dotenv/config";

const dbUrl = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL?.replace(/\/([^/?]+)(\?.*)?$/, "/$1_e2e$2");
if (!dbUrl) throw new Error("DATABASE_URL or E2E_DATABASE_URL is required");
const photoRoot = process.env.E2E_PHOTO_ROOT ?? "/tmp/photoalbum-e2e-photos";
mkdirSync(photoRoot, { recursive: true });
if (!existsSync(".next/standalone/server.js")) throw new Error("Run `pnpm build` before the e2e tests");
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
cpSync("public", ".next/standalone/public", { recursive: true });

const env = { ...process.env, DATABASE_URL: dbUrl, PHOTO_STORAGE_ROOT: photoRoot, PORT: "3200", HOSTNAME: "127.0.0.1", APP_URL: "http://localhost:3200", SMTP_HOST: "", RUN_WORKER: "true", NODE_ENV: "production" };
const migrate = spawn("./node_modules/.bin/prisma", ["migrate", "deploy"], { env, stdio: "inherit" });
migrate.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const server = spawn("node", [".next/standalone/server.js"], { env, stdio: "inherit" });
  server.on("exit", (c) => process.exit(c ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));
});
