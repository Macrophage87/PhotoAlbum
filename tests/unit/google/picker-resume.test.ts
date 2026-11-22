import { describe, expect, it } from "vitest";
import { clearSavedPicker, opensInSameTab, parseSavedPicker, PICKER_STORAGE_KEY, readSavedPicker, savePicker } from "@/lib/google/picker-resume";

const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const win = (coarse: boolean, fine: boolean, innerWidth: number) => ({ innerWidth, matchMedia: (q: string) => ({ matches: q.includes("coarse") ? coarse : q.includes("fine") ? fine : false }) as MediaQueryList });

describe("where the picker opens Google's page", () => {
  it("stays in this tab on a phone or a narrow window, and opens a new tab on a computer", () => {
    expect(opensInSameTab(win(true, false, 400))).toBe(true);
    expect(opensInSameTab(win(true, false, 1024))).toBe(true); // a tablet
    expect(opensInSameTab(win(false, false, 500))).toBe(true); // a narrow window
    expect(opensInSameTab(win(false, true, 1280))).toBe(false);
    expect(opensInSameTab(win(true, true, 1280))).toBe(false); // a touch laptop with a mouse
    expect(opensInSameTab(undefined)).toBe(false);
  });
});

describe("what the picker remembers", () => {
  it("keeps a picking session and, once copying, the photo ids, so a lost tab still reaches the review screen", () => {
    const s = memory();
    savePicker({ stage: "picking", sessionId: "s1", pickerUri: "https://photos.google.com/picker/s1", pollIntervalMs: 3000, deadline: 99, mode: "same" }, s);
    expect(readSavedPicker(s)).toEqual({ stage: "picking", sessionId: "s1", pickerUri: "https://photos.google.com/picker/s1", pollIntervalMs: 3000, deadline: 99, mode: "same" });
    savePicker({ stage: "downloading", photoIds: ["a", "b"], skipped: 1, unsupported: 0 }, s);
    expect(readSavedPicker(s)).toEqual({ stage: "downloading", photoIds: ["a", "b"], skipped: 1, unsupported: 0 });
    clearSavedPicker(s);
    expect(readSavedPicker(s)).toBeNull();
  });
  it("reads what the earlier version saved as a picking session, and ignores anything it does not recognise", () => {
    expect(parseSavedPicker(JSON.stringify({ sessionId: "s1", pickerUri: "u" }), 1000)).toEqual({ stage: "picking", sessionId: "s1", pickerUri: "u", pollIntervalMs: 5000, deadline: 1000 + 30 * 60_000, mode: "blocked" });
    for (const raw of [null, "", "{", "null", "[]", "42", JSON.stringify({ stage: "downloading", photoIds: [] }), JSON.stringify({ stage: "picking", sessionId: "s1" }), JSON.stringify({ stage: "other" })]) expect(parseSavedPicker(raw), String(raw)).toBeNull();
    expect(parseSavedPicker(JSON.stringify({ stage: "downloading", photoIds: ["a", 3, ""], skipped: "x" }))).toEqual({ stage: "downloading", photoIds: ["a"], skipped: 0, unsupported: 0 });
  });
  it("carries on without storage when the browser refuses it", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("denied"); } };
    expect(() => savePicker({ stage: "downloading", photoIds: ["a"], skipped: 0, unsupported: 0 }, broken)).not.toThrow();
    expect(readSavedPicker(broken)).toBeNull();
    expect(() => clearSavedPicker(broken)).not.toThrow();
    expect(PICKER_STORAGE_KEY).toBe("google-picker-session");
  });
});
