import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";

// env() parses process.env once and caches it, so each case here supplies its own value instead.
const current: { TOKEN_ENCRYPTION_KEY?: string } = {};
vi.mock("@/lib/env", () => ({ env: () => current }));

const { decryptSecret, encryptSecret, keyFromEnv } = await import("@/lib/google/crypto");

describe("TOKEN_ENCRYPTION_KEY", () => {
  afterEach(() => { delete current.TOKEN_ENCRYPTION_KEY; });

  it("refuses to work without a key", () => {
    expect(() => keyFromEnv()).toThrow("TOKEN_ENCRYPTION_KEY is not set");
    expect(() => encryptSecret("x")).toThrow("TOKEN_ENCRYPTION_KEY is not set");
  });

  it("refuses an empty key", () => {
    current.TOKEN_ENCRYPTION_KEY = "";
    expect(() => keyFromEnv()).toThrow("TOKEN_ENCRYPTION_KEY is not set");
  });

  it.each([16, 31, 33, 64])("refuses a key that decodes to %i bytes", (n) => {
    current.TOKEN_ENCRYPTION_KEY = randomBytes(n).toString("base64");
    expect(() => keyFromEnv()).toThrow("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  });

  it("refuses a hex key, which is 64 characters but not 32 bytes once read as base64", () => {
    current.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    expect(() => keyFromEnv()).toThrow("must decode to 32 bytes");
  });

  it("uses a 32-byte base64 key, and seals with it by default", () => {
    const key = randomBytes(32);
    current.TOKEN_ENCRYPTION_KEY = key.toString("base64");
    expect(keyFromEnv().equals(key)).toBe(true);
    const sealed = encryptSecret("1//refresh");
    expect(decryptSecret(sealed, key)).toBe("1//refresh");
    expect(decryptSecret(sealed)).toBe("1//refresh");
  });
});
