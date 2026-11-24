import { AppShell, Container } from "@/components/layout/AppShell";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { db } from "@/lib/db";
import { isAdmin } from "@/lib/auth/ownership";
import { uploaderLabel } from "@/components/photos/toGrid";
import { RemoveSong, SongUploader } from "@/components/music/SongUploader";
import { MAX_SONG_BYTES } from "@/lib/music/songs";

export const metadata = { title: "Music", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * The album's music: songs the family has added to play under a slideshow on a television. The phone app chooses
 * from this list when it casts. Members only.
 */
export default async function MusicPage() {
  const user = await requireUser("/music");
  const viewer = await getViewer();
  if (viewer.kind !== "user") return null;
  const songs = await db.song.findMany({ where: { path: { not: "pending" } }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], select: { id: true, title: true, sizeBytes: true, uploaderId: true, uploader: { select: { name: true, email: true } } } });
  return (
    <AppShell viewer={viewer}>
      <Container className="py-8 space-y-6">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold">Music</h1>
          <p className="text-muted max-w-prose">
            Songs added here can be played on the TV while the phone app shows a slideshow. Add files you own, such as MP3 or M4A, up to {Math.round(MAX_SONG_BYTES / 1024 / 1024)} MB each. Only family members who are signed in can hear them.
          </p>
        </div>
        <SongUploader />
        {songs.length === 0 ? (
          <p className="text-muted" data-testid="no-songs">No songs yet.</p>
        ) : (
          <ul className="divide-y divide-border" data-testid="songs">
            {songs.map((song) => (
              <li key={song.id} className="py-3 flex flex-wrap items-center gap-3">
                <div className="min-w-48 flex-1">
                  <div className="font-medium">{song.title}</div>
                  <div className="text-sm text-muted">
                    Added by {song.uploader ? uploaderLabel(song.uploader.name, song.uploader.email) : "a former member"} · {(song.sizeBytes / 1024 / 1024).toFixed(1)} MB
                  </div>
                </div>
                <audio controls preload="none" src={`/api/music/${song.id}`} className="h-9 max-w-full" />
                {(song.uploaderId === user.id || isAdmin(user)) && <RemoveSong id={song.id} title={song.title} />}
              </li>
            ))}
          </ul>
        )}
      </Container>
    </AppShell>
  );
}
