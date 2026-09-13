import { ALLOWED_MIMES, EXT_MIME, SCAN_MIMES, VIDEO_MIMES } from "./mime";

/**
 * What the browser hands over when a file is chosen. Phones are unreliable about the type: a scanner's .glb arrives
 * as an empty string, a .mov out of the Files app often arrives as application/octet-stream, and anything reached
 * through a cloud provider can arrive with no type at all. So the name has the last word.
 */
export type PickedFile = { name: string; type: string };

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The type the album will treat this file as, or null when it is not something the album keeps. */
export function mimeOfPicked(file: PickedFile): string | null {
  const byName = EXT_MIME[extensionOf(file.name)] ?? null;
  if (byName) return byName;
  const given = file.type.split(";")[0]!.trim().toLowerCase();
  return ALLOWED_MIMES.has(given) ? given : null;
}

export const albumTakes = (file: PickedFile) => mimeOfPicked(file) !== null;
export const isVideoPick = (file: PickedFile) => VIDEO_MIMES.has(mimeOfPicked(file) ?? "");
export const isScanPick = (file: PickedFile) => SCAN_MIMES.has(mimeOfPicked(file) ?? "");

/**
 * Why a file was left behind. Since the file chooser no longer narrows what a phone will offer — narrowing it is
 * what sent people to the photo app and nowhere else — a member can now pick a PDF, and deserves to be told.
 */
export function refusalFor(file: PickedFile): string {
  const ext = extensionOf(file.name);
  const what = ext ? `.${ext} files` : "this kind of file";
  return `The album doesn't take ${what} — photographs, short clips and 3D scans only.`;
}
