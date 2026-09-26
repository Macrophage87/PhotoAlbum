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
  try {
    await unlink(safeArchivePath(name));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // An inbox volume made before the image created /data/imports belongs to root; see docs/DEPLOY.md.
    if (code === "EACCES" || code === "EPERM") throw new ArchiveDeleteError(`The server is not allowed to delete ${name}: the inbox folder is not writable by the app. See "Takeout inbox permissions" in docs/DEPLOY.md.`);
    if (code === "ENOENT") throw new ArchiveDeleteError(`${name} is no longer in the inbox.`);
    throw err;
  }
}

/** A reason to show an admin as it is, since a thrown server-action message is hidden in production. */
export class ArchiveDeleteError extends Error {}
