import Link from "next/link";
import { db } from "@/lib/db";
import { getViewer, requireAdmin } from "@/lib/auth/viewer";
import { AppShell, Container } from "@/components/layout/AppShell";
import { TrashTable } from "@/components/admin/TrashTable";
import { photoUrl } from "@/lib/photos/urls";
import { uploaderLabel } from "@/components/photos/toGrid";
import { isRemovalRequest, trashReasonLabel } from "@/lib/photos/trash";

export const metadata = { title: "Trash" };

/** Everything family members have taken out of the album, newest first, for an admin to restore or delete for good. */
export default async function TrashPage() {
  await requireAdmin("/admin/trash");
  const viewer = await getViewer();
  const rows = await db.photo.findMany({
    where: { trashedAt: { not: null } },
    orderBy: { trashedAt: "desc" },
    select: {
      id: true, title: true, caption: true, originalName: true, kind: true, updatedAt: true, takenAt: true, trashedAt: true, trashReason: true, trashNote: true,
      trashedBy: { select: { name: true, email: true } },
      uploader: { select: { name: true, email: true } },
      trip: { select: { slug: true, title: true } },
    },
  });
  const items = rows.map((p) => ({
    id: p.id,
    label: p.title ?? p.caption ?? p.originalName,
    thumbUrl: p.kind === "EXTERNAL_VIDEO" ? null : photoUrl(p, "thumb"),
    trashedAt: p.trashedAt!.toISOString(),
    trashedBy: p.trashedBy ? uploaderLabel(p.trashedBy.name, p.trashedBy.email) : null,
    uploadedBy: uploaderLabel(p.uploader?.name, p.uploader?.email),
    reason: trashReasonLabel(p.trashReason, p.trashNote),
    removalRequest: isRemovalRequest(p.trashReason),
    trip: p.trip ? { slug: p.trip.slug, title: p.trip.title } : null,
  }));

  return (
    <AppShell viewer={viewer}>
      <Container className="py-8 space-y-6">
        <div>
          <p className="text-sm text-muted"><Link href="/admin" className="text-primary hover:underline">Admin</Link> / Trash</p>
          <h1 className="font-display text-3xl font-semibold mt-1">Trash</h1>
          <p className="text-muted mt-2 max-w-2xl">
            Items family members have taken out of the album. They are already hidden everywhere — galleries, the timeline, the map, search and every share link — but the files are still here, so restoring puts an item back exactly as it was. Deleting removes the record and the file from this server for good.
          </p>
        </div>
        <TrashTable items={items} />
      </Container>
    </AppShell>
  );
}
