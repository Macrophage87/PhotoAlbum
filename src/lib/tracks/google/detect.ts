export type GoogleFormat = "records" | "timeline-android" | "timeline-ios" | "semantic";

/** Sniff which Google export shape a file is from its first kilobytes. */
export function detectGoogleFormat(head: string): GoogleFormat | null {
  const s = head.trimStart();
  if (s.startsWith("[")) return "timeline-ios";
  if (!s.startsWith("{")) return null;
  const first = s.slice(0, 64 * 1024);
  if (/"semanticSegments"\s*:/.test(first)) return "timeline-android";
  if (/"timelineObjects"\s*:/.test(first)) return "semantic";
  if (/"locations"\s*:/.test(first)) return "records";
  // Older Android exports can lead with rawSignals; fall back to whichever key appears first later.
  if (/"rawSignals"\s*:/.test(first)) return "timeline-android";
  return null;
}
