import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { env } from "@/lib/env";

export type Archive = { name: string; bytes: number; modifiedAt: Date };

export function inboxDir(): string | null {
  return env().IMPORT_INBOX_DIR ?? null;
}

/** Only a plain file name inside the inbox, ending in .zip, is ever accepted from the UI. */
export function safeArchivePath(name: string): string {
  const dir = inboxDir();
  if (!dir) throw new Error("Takeout import is not configured (IMPORT_INBOX_DIR)");
  if (name !== path.basename(name) || !/\.zip$/i.test(name) || name.startsWith(".")) throw new Error("Not an archive name");
  return path.join(dir, name);
}

export async function listArchives(): Promise<Archive[]> {
  const dir = inboxDir();
  if (!dir) return [];
  const names = await readdir(dir).catch(() => [] as string[]);
  const out: Archive[] = [];
  for (const name of names) {
    if (!/\.zip$/i.test(name) || name.startsWith(".")) continue;
    const s = await stat(path.join(dir, name)).catch(() => null);
    if (s?.isFile()) out.push({ name, bytes: s.size, modifiedAt: s.mtime });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteArchive(name: string): Promise<void> {
  await unlink(safeArchivePath(name));
}
