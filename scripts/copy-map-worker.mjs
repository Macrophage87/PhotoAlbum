/* MapLibre spawns its worker from import.meta.url, which bundlers mangle. Serve the worker files statically instead. */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const dist = path.dirname(require.resolve("maplibre-gl/package.json")) + "/dist";
const out = new URL("../public/maplibre/", import.meta.url).pathname;
mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(path.join(dist, f), path.join(out, f));
console.log("[copy-map-worker] copied MapLibre worker to public/maplibre");
