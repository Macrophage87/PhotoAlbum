"use server";

import { headers } from "next/headers";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";
import { submitNote, type NoteState } from "@/lib/notes/notes";

/** The note form's action: anybody may send one, member or not (see `submitNote` for what stops a flood). */
export async function sendNote(_prev: NoteState, fd: FormData): Promise<NoteState> {
  return submitNote(fd, { viewer: await getViewer(), headers: await headers(), appUrl: env().APP_URL });
}
