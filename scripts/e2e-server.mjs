/* Starts the standalone production build on port 3200 with the e2e database and a scratch photo dir. */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import "dotenv/config";
import { startMocks } from "../tests/e2e/mocks.mjs";

const dbUrl = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL?.replace(/\/([^/?]+)(\?.*)?$/, "/$1_e2e$2");
if (!dbUrl) throw new Error("DATABASE_URL or E2E_DATABASE_URL is required");
const photoRoot = process.env.E2E_PHOTO_ROOT ?? "/tmp/photoalbum-e2e-photos";
mkdirSync(photoRoot, { recursive: true });
if (!existsSync(".next/standalone/server.js")) throw new Error("Run `pnpm build` before the e2e tests");
cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
cpSync("public", ".next/standalone/public", { recursive: true });

const MOCK_PORT = 3201;
startMocks(MOCK_PORT);
const env = { ...process.env, DATABASE_URL: dbUrl,
  YOUTUBE_OEMBED_URL: `http://127.0.0.1:${MOCK_PORT}/oembed`, YOUTUBE_THUMBNAIL_URL: `http://127.0.0.1:${MOCK_PORT}/vi`,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, ML_URL: `http://127.0.0.1:${MOCK_PORT}`, ML_TOKEN: "e2e-ml-token", FACE_INDEXING_ENABLED: "true", ANTHROPIC_API_KEY: "sk-ant-e2e-dummy", ANNOTATION_ENABLED: "true", ANNOTATION_QUIET_MINUTES: "30", PHOTO_STORAGE_ROOT: photoRoot, PORT: "3200", HOSTNAME: "127.0.0.1", APP_URL: "http://localhost:3200", SMTP_HOST: "", RUN_WORKER: "true", NODE_ENV: "production", ADMIN_EMAIL: process.env.E2E_ADMIN_EMAIL ?? "e2e-admin@example.com" };
const migrate = spawn("./node_modules/.bin/prisma", ["migrate", "deploy"], { env, stdio: "inherit" });
migrate.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const server = spawn("node", [".next/standalone/server.js"], { env, stdio: "inherit" });
  server.on("exit", (c) => process.exit(c ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.kill(sig));
});
