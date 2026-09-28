import type { Metadata } from "next";
import { headers } from "next/headers";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { photoUrl } from "@/lib/photos/urls";
import { safeNextPath } from "@/lib/auth/tokens";
import { notePagePath, visiblePhoto } from "@/lib/notes/notes";
import { issueFormToken } from "@/lib/notes/token";
import { NoteForm } from "./NoteForm";

export const metadata: Metadata = { title: "Send the family a note", robots: { index: false, follow: false } };

/**
 * Where anybody looking at the album, member or not, can write to the family. A plain page rather than a dialog, so
 * it works without JavaScript; the footer links here from every page, and the photo viewer with `?photo=<id>`.
 */
export default async function NotePage({ searchParams }: PageProps<"/note">) {
  const viewer = await getViewer();
  const asked = (await searchParams).photo;
  const photoParam = typeof asked === "string" ? asked.slice(0, 64) : "";
  // A photograph this viewer cannot see, and one that does not exist, are drawn the same way: as no photograph.
  const photo = await visiblePhoto(viewer, photoParam);
  // Where they came from, so the family knows what they were looking at (a path on this album only, with no share
  // token), and so the thank-you can take them back there (their own address, token and all).
  const referer = (await headers()).get("referer");
  const page = notePagePath(referer, env().APP_URL) ?? "";
  const from = page && referer ? new URL(referer, env().APP_URL) : null;
  const back = from ? safeNextPath(from.pathname + from.search) : "/";
  const token = await issueFormToken();
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 max-w-xl space-y-6">
        <div>
          <h1 className="font-display text-3xl font-semibold">Send the family a note</h1>
          <p className="text-muted mt-2">Enjoyed a photo, spotted someone you know, or just want to say hello? Write to us here.</p>
        </div>
        {photo && (
          <div className="flex items-center gap-3 text-sm text-muted" data-testid="note-photo">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {photo.kind !== "EXTERNAL_VIDEO" && <img src={photoUrl(photo, "thumb")} alt="" className="h-16 w-16 rounded-theme object-cover" />}
            <span>About this photo</span>
          </div>
        )}
        <NoteForm token={token} photo={photoParam} page={page} back={back} />
      </Container>
    </AppShell>
  );
}
