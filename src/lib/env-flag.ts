/**
 * An on/off setting as src/lib/env.ts reads it (1, true, yes or on, in any case), without validating the whole
 * environment: for the proxy, which reads its few settings straight from process.env on every request.
 */
export function envFlag(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").toLowerCase());
}
