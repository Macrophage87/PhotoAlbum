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
  // Short clips only: longer videos go to YouTube. Phone video runs 65 to 400 MB per minute, hence the separate byte cap.
  MAX_CLIP_SECONDS: z.coerce.number().int().positive().default(90),
  MAX_VIDEO_UPLOAD_BYTES: z.coerce.number().int().positive().default(1024 * 1024 * 1024),
  RUN_WORKER: boolish.transform((v) => v ?? true),
  // External services are reached only through these base URLs so tests can point them at a mock server.
  YOUTUBE_OEMBED_URL: z.string().url().default("https://www.youtube.com/oembed"),
  YOUTUBE_THUMBNAIL_URL: z.string().url().default("https://i.ytimg.com/vi"),
  YOUTUBE_DATA_API_URL: z.string().url().default("https://www.googleapis.com/youtube/v3"),
  YOUTUBE_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
  // AI annotation: off until both the operator flag and an admin's opt-in on the disclosure screen are set.
  ANTHROPIC_API_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
  ANTHROPIC_BASE_URL: z.string().url().optional().transform((v) => (v ? v : undefined)),
  ANNOTATION_ENABLED: boolish.transform((v) => v ?? false),
  ANNOTATION_MODEL: z.enum(["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]).default("claude-opus-5"),
  ANNOTATION_QUIET_MINUTES: z.coerce.number().int().positive().default(30),
  ANNOTATION_RAW_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  // Local ML sidecar (faces, image and text embeddings). Optional; when set, ML_TOKEN is required so the app fails closed.
  ML_URL: z.string().url().optional().transform((v) => (v ? v : undefined)),
  ML_TOKEN: z.string().optional().transform((v) => (v ? v : undefined)),
  // Documented pass-through for the sidecar (compose hands it to the ml service); the app itself does not read it.
  ML_IDLE_UNLOAD_SECONDS: z.coerce.number().int().positive().default(300),
  // Face detection stays off until this flag and an admin's opt-in on the disclosure screen are both set.
  FACE_INDEXING_ENABLED: boolish.transform((v) => v ?? false),
  FACE_UNNAMED_RETENTION_DAYS: z.coerce.number().int().positive().default(180),
  // Google Takeout import: archives are read from this server-side folder (a compose volume); hidden when unset.
  IMPORT_INBOX_DIR: z.string().optional().transform((v) => (v ? v : undefined)),
  // Google Photos Picker: hidden until both OAuth values are set; refresh tokens are encrypted under TOKEN_ENCRYPTION_KEY.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional().transform((v) => (v ? v : undefined)),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional().transform((v) => (v ? v : undefined)),
  TOKEN_ENCRYPTION_KEY: z.string().optional().transform((v) => (v ? v : undefined)),
  GOOGLE_ACCOUNTS_URL: z.string().url().default("https://accounts.google.com"),
  GOOGLE_OAUTH_BASE_URL: z.string().url().default("https://oauth2.googleapis.com"),
  GOOGLE_PHOTOS_API_URL: z.string().url().default("https://photospicker.googleapis.com/v1"),
  // Automatic pet matching through the sidecar's animal detector (needs ML_URL); on by default when the sidecar is set.
  PET_MATCHING_ENABLED: boolish.transform((v) => v ?? true),
  // Send the page Content-Security-Policy as report-only (browser console warnings instead of blocking) while trying a new tile or style host.
  CSP_REPORT_ONLY: boolish.transform((v) => v ?? false),
})
  .refine((e) => !e.ML_URL || Boolean(e.ML_TOKEN), { message: "ML_TOKEN is required when ML_URL is set", path: ["ML_TOKEN"] })
  .refine((e) => !e.GOOGLE_OAUTH_CLIENT_ID || Boolean(e.GOOGLE_OAUTH_CLIENT_SECRET), { message: "GOOGLE_OAUTH_CLIENT_SECRET is required with GOOGLE_OAUTH_CLIENT_ID", path: ["GOOGLE_OAUTH_CLIENT_SECRET"] })
  .refine((e) => !e.GOOGLE_OAUTH_CLIENT_ID || (Boolean(e.TOKEN_ENCRYPTION_KEY) && Buffer.from(e.TOKEN_ENCRYPTION_KEY ?? "", "base64").length === 32), { message: "TOKEN_ENCRYPTION_KEY (32 bytes, base64) is required when Google OAuth is configured", path: ["TOKEN_ENCRYPTION_KEY"] });

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
