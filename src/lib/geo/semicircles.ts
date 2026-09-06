export const FIT_INVALID_SINT32 = 0x7fffffff;

/** FIT stores positions as 2^31 semicircles per 180°. */
export function semicirclesToDegrees(s: number): number | null {
  if (!Number.isFinite(s) || s === FIT_INVALID_SINT32) return null;
  return s * (180 / 2 ** 31);
}

export function degreesToSemicircles(d: number): number {
  return Math.round(d * (2 ** 31 / 180));
}
