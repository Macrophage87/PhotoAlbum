/** Douglas–Peucker on lat/lng pairs, working in local metres. Iterative so 500k-point inputs don't blow the stack. */
export function simplifyLine(points: { lat: number; lng: number }[], toleranceM: number, maxVertices = 5000): { line: [number, number][]; indices: number[] } {
  const n = points.length;
  if (n <= 2) return { line: points.map((p) => [p.lat, p.lng]), indices: points.map((_, i) => i) };
  const lat0 = (points[0].lat * Math.PI) / 180;
  const kx = 111_320 * Math.cos(lat0);
  const ky = 110_540;
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = points[i].lng * kx;
    ys[i] = points[i].lat * ky;
  }

  let tol = toleranceM;
  for (let attempt = 0; attempt < 12; attempt++) {
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack: [number, number][] = [[0, n - 1]];
    const tol2 = tol * tol;
    while (stack.length) {
      const [s, e] = stack.pop()!;
      if (e - s < 2) continue;
      const ax = xs[s], ay = ys[s], bx = xs[e], by = ys[e];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      let maxD2 = -1, idx = -1;
      for (let i = s + 1; i < e; i++) {
        let d2: number;
        if (len2 === 0) {
          d2 = (xs[i] - ax) ** 2 + (ys[i] - ay) ** 2;
        } else {
          const t = Math.max(0, Math.min(1, ((xs[i] - ax) * dx + (ys[i] - ay) * dy) / len2));
          d2 = (xs[i] - (ax + t * dx)) ** 2 + (ys[i] - (ay + t * dy)) ** 2;
        }
        if (d2 > maxD2) {
          maxD2 = d2;
          idx = i;
        }
      }
      if (maxD2 > tol2 && idx > 0) {
        keep[idx] = 1;
        stack.push([s, idx], [idx, e]);
      }
    }
    const indices: number[] = [];
    for (let i = 0; i < n; i++) if (keep[i]) indices.push(i);
    if (indices.length <= maxVertices) {
      return { line: indices.map((i) => [points[i].lat, points[i].lng]), indices };
    }
    tol *= 2;
  }
  // Fallback: uniform sampling that always includes both endpoints and never exceeds the cap
  const step = Math.ceil((n - 1) / (maxVertices - 1));
  const indices = [];
  for (let i = 0; i < n - 1; i += step) indices.push(i);
  indices.push(n - 1);
  return { line: indices.map((i) => [points[i].lat, points[i].lng]), indices };
}
