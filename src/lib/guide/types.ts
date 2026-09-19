/**
 * The family's guide, as data.
 *
 * It is a page on the site and a PDF to print, and the two must say the same thing, so neither owns the words:
 * `content.json` does. The page renders it (`/guide`) and `scripts/make-guide-pdf.py` lays the same blocks out on
 * paper. Add a section to the JSON and both grow it.
 *
 * Inline markup is deliberately two rules, because a guide written for whoever is least sure about computers is
 * not the place for a markdown parser: `**bold**` for the words somebody presses, and `_italic_` for an example
 * they might type.
 */
export type GuideBlock =
  | { kind: "p"; text: string }
  | { kind: "h3"; text: string }
  | { kind: "note"; text: string }
  | { kind: "small"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "steps"; items: string[] }
  | { kind: "table"; columns: string[]; rows: string[][] };

export type GuideSection = { id: string; heading: string; blocks: GuideBlock[] };

export type Guide = { title: string; subtitle: string; intro: GuideBlock[]; sections: GuideSection[] };

/** Split `**bold**` and `_italic_` into runs. Anything unmatched stays as it was typed. */
export function inlineRuns(text: string): { text: string; bold?: boolean; italic?: boolean }[] {
  const runs: { text: string; bold?: boolean; italic?: boolean }[] = [];
  const pattern = /\*\*([^*]+)\*\*|_([^_]+)_/g;
  let at = 0;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > at) runs.push({ text: text.slice(at, m.index) });
    runs.push(m[1] !== undefined ? { text: m[1], bold: true } : { text: m[2], italic: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) runs.push({ text: text.slice(at) });
  return runs;
}
