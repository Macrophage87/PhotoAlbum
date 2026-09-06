export type TrackFileKind = "gpx" | "fit" | "google";

/** Decide how to parse a file from its extension, then from its first bytes. */
export function detectTrackKind(fileName: string, head: Buffer, hint: "auto" | TrackFileKind = "auto"): TrackFileKind | null {
  if (hint !== "auto") return hint;
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "gpx") return "gpx";
  if (ext === "fit") return "fit";
  if (ext === "json") return "google";
  if (head.length >= 12 && head.toString("ascii", 8, 12) === ".FIT") return "fit";
  const text = head.toString("utf8", 0, Math.min(head.length, 4096)).trimStart();
  if (text.startsWith("<") && /<gpx[\s>]/i.test(text)) return "gpx";
  if (text.startsWith("{") || text.startsWith("[")) return "google";
  return null;
}
