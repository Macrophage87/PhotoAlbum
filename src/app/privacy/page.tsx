import { env } from "@/lib/env";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Card } from "@/components/ui";
import { annotationGates } from "@/lib/annotation/eligibility";
import { mlConfigured } from "@/lib/ml/client";
import { faceGates } from "@/lib/people/gates";
import { faceCounts } from "@/lib/people/queries";

export const metadata = { title: "Privacy", robots: { index: false, follow: false } };

type Flow = { name: string; what: string; when: string; off: string; enabled: boolean };

/**
 * Members-only page listing every way data leaves this server, which switch controls it, and what is kept.
 * Each phase that adds an outbound flow extends this list in the same commit.
 */
export default async function PrivacyPage() {
  await requireUser("/privacy");
  const viewer = await getViewer();
  const e = env();
  const gates = await annotationGates();
  const fg = await faceGates();
  const fc = await faceCounts(fg.retentionDays);
  const flows: Flow[] = [
    {
      name: "AI descriptions (Anthropic)",
      what: "For each new item after review: the 1600-pixel rendition (three or four frames for a clip), the uploader's notes, caption and title, the date and camera when known, and the trip and collection titles. Never the original file, never face data, and people's names only under the consent rule for confirmed people. The helper answers with a caption, description, tags and a search summary.",
      when: `Only while both switches are on: the operator flag (${gates.envEnabled ? "on" : "off"}) and an admin's opt-in on the Admin page (${gates.optedInAt ? "on" : "off"}). Items, trips and collections can be opted out individually and are then never sent.`,
      off: `Turn the opt-in off on the Admin page, or set ANNOTATION_ENABLED=false. Raw responses are kept ${e.ANNOTATION_RAW_RETENTION_DAYS} days for debugging, then purged; they are deleted with the item.`,
      enabled: gates.active,
    },
    {
      name: "Sign-in and invite email",
      what: "The recipient's address and a one-time sign-in link.",
      when: "When a member requests a sign-in link or an admin sends an invite.",
      off: "Leave SMTP_HOST empty; links are printed to the server log instead.",
      enabled: Boolean(e.SMTP_HOST),
    },
    {
      name: "Map tiles",
      what: "Your browser asks the configured tile server for map images as you pan; the server learns this site's origin, never a photo, trip or share link.",
      when: "Whenever a map is open.",
      off: "Point NEXT_PUBLIC_TILE_URL at a self-hosted tile server, or avoid the map pages.",
      enabled: true,
    },
    {
      name: "YouTube (embedded videos)",
      what: "When a member adds a video, the server asks YouTube for its title and poster and stores the poster here, so galleries never call YouTube. When a viewer presses play, their browser loads the player from youtube-nocookie.com and YouTube sees that request (this site's origin, not the page or any share link). A weekly server-side check asks YouTube whether each video still exists.",
      when: "Adding a video, pressing play, and the weekly check.",
      off: "Do not add YouTube videos; nothing is contacted for photos.",
      enabled: true,
    },
    {
      name: "Facebook share button",
      what: "Nothing until pressed. Pressing it opens Facebook in a new tab with the trip or collection address; Facebook then fetches that public page or secret link to build a preview.",
      when: "Only when a member or visitor presses the button on a public or link-shared trip or collection.",
      off: "Keep trips and collections private; the button appears only on shared ones.",
      enabled: true,
    },
  ];
  return (
    <AppShell viewer={viewer}>
      <Container className="py-10 max-w-3xl space-y-8">
        <div>
          <h1 className="font-display text-3xl font-semibold">Privacy</h1>
          <p className="text-muted mt-1">What leaves this server, what stays, and who can see what.</p>
        </div>

        <section className="space-y-3">
          <h2 className="font-display text-xl font-semibold">What leaves the server</h2>
          {flows.map((f) => (
            <Card key={f.name} className="p-4 space-y-1 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{f.name}</span>
                <span className={`text-xs rounded-full px-2 py-0.5 ${f.enabled ? "bg-emerald-100 text-emerald-800" : "bg-surface-alt text-muted"}`}>{f.enabled ? "on" : "off"}</span>
              </div>
              <p><span className="text-muted">Sent:</span> {f.what}</p>
              <p><span className="text-muted">When:</span> {f.when}</p>
              <p><span className="text-muted">To turn off:</span> {f.off}</p>
            </Card>
          ))}
          <p className="text-sm text-muted">Photos, short clips (transcoded here with ffmpeg, originals kept) and location traces are stored on this server only; longer videos live on YouTube as unlisted videos, which means anyone with the YouTube link can watch them regardless of this album&apos;s settings. The optional ML sidecar (image and text embeddings for similarity, suggestions and semantic search; face templates in a later phase) runs on this server only, on an internal network with no outbound access, and writes nothing to disk or logs{mlConfigured() ? " (configured)" : " (not configured)"}. </p>
        </section>

        <section className="space-y-2 text-sm">
          <h2 className="font-display text-xl font-semibold">Faces (stays on this server)</h2>
          <p>Face detection is {fg.active ? "on" : "off"}: operator flag {fg.envEnabled ? "on" : "off"}, admin opt-in {fg.optedInAt ? "on" : "off"}, sidecar {fg.sidecar ? "configured" : "not configured"}. When on, a face template is computed for every face in every new photo and kept in this server&apos;s database only; nothing is sent anywhere. Templates: {fc.templates} stored, {fc.unnamed} unnamed{fc.nextPurge ? `, the oldest purged by ${fc.nextPurge.toLocaleDateString("en-US")}` : ""}; unnamed faces are deleted after {fg.retentionDays} days. Recognising a named person is a separate per-person decision by an admin, off by default, never for a minor without a parent&apos;s instruction; even then every match is only a proposal until a member confirms it; a person can be forgotten at any time, which deletes their templates and removes their name from descriptions and search. A person&apos;s name reaches the AI helper only when their recognition is on and they are not a minor.</p>
        </section>

        <section className="space-y-2 text-sm">
          <h2 className="font-display text-xl font-semibold">Who can see what</h2>
          <p>Every signed-in family member sees everything. Anonymous visitors see only trips and collections marked public. A secret link opens exactly one trip or collection and never the front page, timeline, map or search.</p>
          <p>A photo is visible to anyone who may open its trip or any collection holding it. Putting a private trip&apos;s photo into a public collection publishes that photo; the album warns before it happens and again when lowering a container would leave photos exposed elsewhere.</p>
          <p>Who uploaded a photo is shown to family members only, by name; email addresses appear only on the admin page.</p>
        </section>

        <section className="space-y-2 text-sm">
          <h2 className="font-display text-xl font-semibold">What is kept</h2>
          <p>Originals are kept as uploaded, plus web-sized renditions. Deleting a photo removes its files. Sign-in sessions last about three months; magic links expire after fifteen minutes and work once.</p>
        </section>
      </Container>
    </AppShell>
  );
}
