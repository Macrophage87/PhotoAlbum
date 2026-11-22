/**
 * What the Google picker button remembers in sessionStorage, so a tab the phone threw away (or that the member left
 * to pick in Google's own page) carries on where it was: still watching the picking session, or still copying the
 * items it queued, all the way to the review screen. Browser-only; no server imports.
 */

export const PICKER_STORAGE_KEY = "google-picker-session";

/** How Google's page was opened: another tab, a tab the browser blocked (only the link is left), or this tab. */
export type PickerOpenMode = "tab" | "blocked" | "same";

export type SavedPicker =
  | { stage: "picking"; sessionId: string; pickerUri: string; pollIntervalMs: number; deadline: number; mode: PickerOpenMode }
  | { stage: "downloading"; photoIds: string[]; skipped: number; unsupported: number };

/**
 * Phones and tablets open Google's page in this same tab and pick up again when the member comes back; a second tab
 * on a phone is easy to lose. A touch screen with no fine pointer, or a narrow window, counts as a phone.
 */
export function opensInSameTab(win: Pick<Window, "matchMedia" | "innerWidth"> | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!win) return false;
  try {
    if (win.matchMedia?.("(pointer: coarse)").matches && !win.matchMedia?.("(pointer: fine)").matches) return true;
  } catch {
    /* an old browser without media queries: fall back on the width */
  }
  return win.innerWidth > 0 && win.innerWidth < 640;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

/** The saved state, or null when there is none or it is not something this version wrote. */
export function parseSavedPicker(raw: string | null, now = Date.now()): SavedPicker | null {
  let v: Record<string, unknown> | null;
  try {
    v = JSON.parse(raw ?? "null");
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  if (v.stage === "downloading") {
    const ids = Array.isArray(v.photoIds) ? v.photoIds.filter(str) : [];
    return ids.length ? { stage: "downloading", photoIds: ids, skipped: num(v.skipped, 0), unsupported: num(v.unsupported, 0) } : null;
  }
  // Written before the stage was recorded: a picking session.
  if ((v.stage === "picking" || v.stage === undefined) && str(v.sessionId) && str(v.pickerUri)) {
    const mode: PickerOpenMode = v.mode === "tab" || v.mode === "same" || v.mode === "blocked" ? v.mode : "blocked";
    return { stage: "picking", sessionId: v.sessionId, pickerUri: v.pickerUri, pollIntervalMs: num(v.pollIntervalMs, 0) || 5000, deadline: num(v.deadline, now + 30 * 60_000), mode };
  }
  return null;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const store = (): Store | null => {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
};

export function readSavedPicker(s: Store | null = store()): SavedPicker | null {
  try {
    return parseSavedPicker(s?.getItem(PICKER_STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

export function savePicker(value: SavedPicker, s: Store | null = store()): void {
  try {
    s?.setItem(PICKER_STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* private mode or full: the page still works, it just cannot resume */
  }
}

export function clearSavedPicker(s: Store | null = store()): void {
  try {
    s?.removeItem(PICKER_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
