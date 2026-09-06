/* Renders the PWA icons in public/icons from icon.svg. Run after changing the SVG. */
import sharp from "sharp";
import { readFileSync } from "node:fs";

const svg = readFileSync(new URL("../public/icons/icon.svg", import.meta.url));
const out = (name) => new URL(`../public/icons/${name}`, import.meta.url).pathname;

await sharp(svg).resize(192, 192).png().toFile(out("icon-192.png"));
await sharp(svg).resize(512, 512).png().toFile(out("icon-512.png"));
await sharp(svg).resize(180, 180).png().toFile(out("apple-touch-icon.png"));
// Maskable icons need the artwork inside the central 80%; pad the design on the brand colour.
await sharp(svg)
  .resize(410, 410)
  .extend({ top: 51, bottom: 51, left: 51, right: 51, background: "#1f3a5f" })
  .png()
  .toFile(out("icon-maskable-512.png"));
console.log("[make-icons] wrote public/icons/*.png");
