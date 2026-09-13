import { env } from "@/lib/env";
import { getViewer, requireUser } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { Card } from "@/components/ui";
import { annotationGates } from "@/lib/annotation/eligibility";
import { mlConfigured } from "@/lib/ml/client";
import { faceGates } from "@/lib/people/gates";
import { petGates } from "@/lib/pets/gates";
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
      what: "For each new item after review: the 1600-pixel rendition (three or four frames for a clip), the uploader's notes, caption and title, the date and camera when known, and the trip and collection titles. Never the original file, never face data, and people's names only for confirmed people whose recognition is on and who are adults, plus confirmed pet names. The helper answers with a short title (used only where the item has none), a caption, description, tags and a search summary. An item with no location is also asked where it was taken: the helper only answers for public places anyone could name (a landmark, a park, a waterfront, a region), places somewhere private (a house, a garden, a residential street) no closer than the town or city it sits in, never the building or the address, and is told never to work a location out from a house number, a plate or a uniform; its guess is marked as a guess wherever it shows, never replacing a position from the camera, a track, Google or a family member.",
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
      name: "YouTube Data API (video length)",
      what: "The video id only, to read its duration for the card. No key, no call: the length is then simply not shown.",
      when: "Once, when a member adds a video, and only when YOUTUBE_API_KEY is set.",
      off: "Leave YOUTUBE_API_KEY empty.",
      enabled: Boolean(e.YOUTUBE_API_KEY),
    },
    {
      name: "Google Photos (pick-a-few import)",
      what: "When a member connects Google, the server keeps only an encrypted token that lets it fetch what that member picks; Google sees this site's address and the member's Google sign-in. Each import asks Google for the picked items only (never the library), and Google leaves the location out of the copies it hands over. Google learns which member imported and when; it never sees anything in this album.",
      when: "Only when a member presses Pick from Google Photos, and only for their own account. Disconnect removes the token here and asks Google to forget the grant.",
      off: "Press Disconnect Google on the upload page, or leave GOOGLE_OAUTH_CLIENT_ID empty and the button never appears.",
      enabled: Boolean(e.GOOGLE_OAUTH_CLIENT_ID),
    },
    {
      name: "Google Takeout (whole-library import)",
      what: "Nothing. An admin copies the Takeout zip files onto this server and the import reads them here; dates, places, captions and Google album names come across, nothing goes back.",
      when: "Never leaves the server. The archive is an unencrypted copy of the export; delete it from the inbox once its photos are in.",
      off: "Leave IMPORT_INBOX_DIR empty.",
      enabled: false,
    },
    {
      name: "Address lookup (OpenStreetMap Nominatim)",
      what: "Only the words a member types into the Look up box when setting a photo's place, sent from the server with this site's host name as the identification that service asks for. Never a photo, its date, or anything else about it.",
      when: "Only when a member presses Look up. Clicking the map or typing coordinates contacts nothing.",
      off: `Set GEOCODER_ENABLED=false (the button then explains that lookup is off), or point GEOCODER_URL at your own server.`,
      enabled: e.GEOCODER_ENABLED,
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
          <p className="text-sm text-muted">Cropping and colour correction are stored as instructions and applied when the album makes its own copies; the file you uploaded is never written over and stays on this server exactly as it arrived. Photos, short clips (transcoded here with ffmpeg, originals kept) and location traces are stored on this server only; longer videos live on YouTube as unlisted videos, which means anyone with the YouTube link can watch them regardless of this album&apos;s settings. The optional ML sidecar (image and text embeddings for similarity, suggestions and semantic search; and face templates when detection is on) runs on this server only, on an internal network with no outbound access, and writes nothing to disk or logs{mlConfigured() ? " (configured)" : " (not configured)"}. </p>
        </section>

        <section className="space-y-2 text-sm">
          <h2 className="font-display text-xl font-semibold">Faces (stays on this server)</h2>
          <p>Face detection is {fg.active ? "on" : "off"}: operator flag {fg.envEnabled ? "on" : "off"}, admin opt-in {fg.optedInAt ? "on" : "off"}, sidecar {fg.sidecar ? "configured" : "not configured"}. When on, a face template is computed for every face in every new photo and kept in this server&apos;s database only; nothing is sent anywhere. Templates: {fc.templates} stored, {fc.unnamed} unnamed{fc.nextPurge ? `, the oldest purged by ${fc.nextPurge.toLocaleDateString("en-US")}` : ""}; unnamed faces are deleted after {fg.retentionDays} days. Recognising a named person is a separate per-person decision by an admin, off by default, never for a minor without a parent&apos;s instruction; even then every match is only a proposal until a member confirms it; a person can be forgotten at any time, which deletes their templates and removes their name from descriptions and search. A person&apos;s name reaches the AI helper only when their recognition is on and they are not a minor.</p>
          <p>Animals are spotted the same way, on this server only, and the pet-spotting flag is {petGates().active ? "on" : "off"}. A crop of each animal is kept as a number vector so the same pet can be recognised again; nothing about it leaves the server, and a pet is only ever proposed, never tagged, until a member confirms.</p>
        </section>

        <section className="space-y-2 text-sm">
          <h2 className="font-display text-xl font-semibold">Who can see what</h2>
          <p>Every signed-in family member sees everything. Anonymous visitors see only trips and collections marked public. A secret link opens exactly one trip or collection and never the front page, timeline, map or search.</p>
          <p>A photo is visible to anyone who may open its trip or any collection holding it. Putting a private trip&apos;s photo into a public collection publishes that photo; the album warns before it happens and again when lowering a container would leave photos exposed elsewhere.</p>
          <p>Who uploaded a photo is shown to family members only, by name; email addresses appear only on the admin page.</p>
        </section>

        <section className="space-y-2 text-sm">
          <h2 className="font-display text-xl font-semibold">What is kept</h2>
          <p>Originals are kept as uploaded, plus web-sized renditions. Deleting a photo removes its files. Sign-in sessions last about three months; magic links expire after fifteen minutes and work once. A member&apos;s Google connection is one encrypted refresh token, deleted when they disconnect or are removed. Photos brought over from Google keep the Google item id so a second import skips them.</p>
        </section>
      </Container>
    </AppShell>
  );
}
