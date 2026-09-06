import "dotenv/config";

// Unit tests that touch the database use the *_test database so dev data is never disturbed.
if (process.env.DATABASE_URL && !process.env.DATABASE_URL.endsWith("_test")) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(/\/([^/?]+)(\?.*)?$/, "/$1_test$2");
}
process.env.PHOTO_STORAGE_ROOT = process.env.PHOTO_STORAGE_ROOT ?? "/tmp/photoalbum-test-storage";
