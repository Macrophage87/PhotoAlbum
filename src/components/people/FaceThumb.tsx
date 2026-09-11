import { photoUrl } from "@/lib/photos/urls";

/** A face crop drawn from the medium rendition with CSS, so no crop file ever exists. */
export function FaceThumb({ photo, box, size = 72 }: { photo: { id: string; updatedAt: Date }; box: [number, number, number, number]; size?: number }) {
  const [x, y, w, h] = box;
  const pad = 0.35;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const side = Math.max(w, h) * (1 + pad);
  const scale = 1 / side;
  return (
    <span className="inline-block overflow-hidden rounded-full border border-border bg-surface-alt" style={{ width: size, height: size }} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photoUrl(photo, "medium")}
        alt=""
        style={{ width: `${scale * 100}%`, height: "auto", maxWidth: "none", transform: `translate(${-(cx - side / 2) * scale * 100}%, ${-(cy - side / 2) * scale * 100}%)`, transformOrigin: "top left" }}
      />
    </span>
  );
}
