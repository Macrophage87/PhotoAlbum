import { photoUrl } from "@/lib/photos/urls";
import { faceCrop } from "@/lib/people/crop";

export type ThumbPhoto = { id: string; updatedAt: Date; width?: number | null; height?: number | null };

/**
 * A face crop drawn from the medium rendition with CSS, so no crop file ever exists.
 *
 * The picture is laid out inside the circle with `left`/`top`, whose percentages are shares of the circle. Moving
 * it with `transform: translate(%)` instead would measure against the picture, which is several times the circle,
 * and land the face outside it — see `lib/people/crop`.
 */
export function FaceThumb({ photo, box, size = 72 }: { photo: ThumbPhoto; box: [number, number, number, number]; size?: number }) {
  const crop = faceCrop(box, photo.width && photo.height ? photo.width / photo.height : 1);
  return (
    <span className="relative inline-block overflow-hidden rounded-full border border-border bg-surface-alt align-middle" style={{ width: size, height: size }} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoUrl(photo, "medium")}
        alt=""
        className="absolute max-w-none"
        style={{ width: `${crop.widthPct}%`, height: `${crop.heightPct}%`, left: `${crop.leftPct}%`, top: `${crop.topPct}%` }}
      />
    </span>
  );
}
