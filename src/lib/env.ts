import { z } from "zod";

const boolish = z
  .string()
  .optional()
  .transform((v) => v === undefined || v === "" ? undefined : ["1", "true", "yes", "on"].includes(v.toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DATABASE_URL: z.string().min(1),
  ADMIN_EMAIL: z.string().email().optional().or(z.literal("").transform(() => undefined)),
  SMTP_HOST: z.string().optional().transform((v) => (v ? v : undefined)),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional().transform((v) => (v ? v : undefined)),
  SMTP_PASS: z.string().optional().transform((v) => (v ? v : undefined)),
  SMTP_SECURE: boolish.transform((v) => v ?? false),
  SMTP_FROM: z.string().default("Family Album <album@localhost>"),
  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  PHOTO_STORAGE_ROOT: z.string().default("/data/photos"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  MAX_IMPORT_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024 * 1024),
  RUN_WORKER: boolish.transform((v) => v ?? true),
  // External services are reached only through these base URLs so tests can point them at a mock server.
  YOUTUBE_OEMBED_URL: z.string().url().default("https://www.youtube.com/oembed"),
  YOUTUBE_THUMBNAIL_URL: z.string().url().default("https://i.ytimg.com/vi"),
  YOUTUBE_DATA_API_URL: z.string().url().default("https://www.googleapis.com/youtube/v3"),
  YOUTUBE_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Validated process.env. Throws with a readable message on first use if misconfigured. */
export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
