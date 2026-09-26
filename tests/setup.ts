import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { testDatabaseUrl } from "./db-url";

// Unit tests that touch the database use the *_test database so dev data is never disturbed.
if (process.env.DATABASE_URL) process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL);
// Always a scratch folder, never the PHOTO_STORAGE_ROOT from .env: that is where a developer's own photos live.
process.env.PHOTO_STORAGE_ROOT = path.join(os.tmpdir(), "photoalbum-test-storage");
