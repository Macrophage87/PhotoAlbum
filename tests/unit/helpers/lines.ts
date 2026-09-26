/**
 * A day of pottering around town with one out-and-back along a straight road in the middle: the GPS wanders on the
 * spot for hours, then the whole ten kilometres out is stored as a single vertex, because a straight line needs no
 * others. Any of the town points may go; that one may not.
 */
export function townWithSpur(): { line: [number, number][]; spur: [number, number] } {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.004;
  const town = (): [number, number] => [44.35 + rand(), -68.2 + rand()];
  const spur: [number, number] = [44.44, -68.2];
  return { line: [...Array.from({ length: 2500 }, town), spur, ...Array.from({ length: 2500 }, town)], spur };
}
