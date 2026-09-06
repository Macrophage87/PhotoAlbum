import "dotenv/config";
import { testDatabaseUrl } from "./db-url";

// Unit tests that touch the database use the *_test database so dev data is never disturbed.
if (process.env.DATABASE_URL) process.env.DATABASE_URL = testDatabaseUrl(process.env.DATABASE_URL);
process.env.PHOTO_STORAGE_ROOT = process.env.PHOTO_STORAGE_ROOT ?? "/tmp/photoalbum-test-storage";
