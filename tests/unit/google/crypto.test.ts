import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret } from "@/lib/google/crypto";

describe("sealed refresh tokens", () => {
  const key = randomBytes(32);
  it("round-trips and never repeats a ciphertext", () => {
    const a = encryptSecret("1//refresh-token", key);
    const b = encryptSecret("1//refresh-token", key);
    expect(a).not.toBe(b);
    expect(a.startsWith("v1.")).toBe(true);
    expect(decryptSecret(a, key)).toBe("1//refresh-token");
    expect(decryptSecret(b, key)).toBe("1//refresh-token");
  });
  it("fails cleanly under another key or after tampering", () => {
    const sealed = encryptSecret("secret", key);
    expect(() => decryptSecret(sealed, randomBytes(32))).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from(Buffer.from(parts[3], "base64url").map((b, i) => (i === 0 ? b ^ 1 : b))).toString("base64url");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
    expect(() => decryptSecret("nonsense", key)).toThrow(/Unrecognized/);
  });
});
