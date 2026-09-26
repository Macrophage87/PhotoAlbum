/**
 * FORGET_KEY as it must be: base64 of exactly 32 random bytes, as `openssl rand -base64 32` (and deploy/update.sh)
 * makes it. Anything else is no key at all: forgetting waits until it is put right (see tombstone.ts).
 */
export function forgetKeySecret(value: string | undefined): Buffer | null {
  if (!value) return null;
  const secret = Buffer.from(value.trim(), "base64");
  return secret.length === 32 ? secret : null;
}

export const INVALID_FORGET_KEY = "FORGET_KEY is set but not valid: it must be 32 random bytes of base64 (openssl rand -base64 32).";
