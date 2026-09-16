"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Select } from "@/components/ui";
import { tagPersonAt, untagPersonAt } from "@/app/people/actions";

export type Tag = { id: string; name: string; personId: string; box: [number, number, number, number]; hand: boolean };
type Known = { id: string; name: string };

/** A new tag covers about this much of the picture: a head and shoulders, roughly, wherever the member pointed. */
const BOX_W = 0.16;
const BOX_H = 0.22;

/**
 * Tagging people on a photograph, the way a family does it: point at somebody and say who they are.
 *
 * The album's detector finds faces looking at the camera in decent light. It misses the ones in profile, at the
 * back, in the dark, and every photograph from before it existed — and it cannot ask. So this is the plain way in:
 * a member points, names, and the album writes down who is where. No template is kept and nothing is recognised
 * from it; it is a caption with a position, which is why anybody who may edit the item may do it.
 */
export function PhotoTagger({ photoId, src, alt, tags, people, canEdit }: { photoId: string; src: string; alt: string; tags: Tag[]; people: Known[]; canEdit: boolean }) {
  const [tagging, setTagging] = useState(false);
  const [placed, setPlaced] = useState<[number, number, number, number] | null>(null);
  const [choice, setChoice] = useState("");
  const [fresh, setFresh] = useState("");
  const [busy, start] = useTransition();
  const surface = useRef<HTMLDivElement>(null);
  const router = useRouter();

  const place = (e: React.MouseEvent) => {
    if (!tagging || !surface.current) return;
    const r = surface.current.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    // The box stays on the picture however close to an edge they pointed.
    setPlaced([clamp(x - BOX_W / 2, 0, 1 - BOX_W), clamp(y - BOX_H / 2, 0, 1 - BOX_H), BOX_W, BOX_H]);
  };

  const save = () =>
    start(async () => {
      if (!placed) return;
      const fd = new FormData();
      if (choice) fd.set("personId", choice);
      else fd.set("name", fresh.trim());
      fd.set("box", JSON.stringify(placed));
      await tagPersonAt(photoId, fd);
      setPlaced(null);
      setChoice("");
      setFresh("");
      router.refresh();
    });

  const show = tagging || Boolean(placed);
  return (
    <div className="space-y-2">
      <div ref={surface} onClick={place} className={`relative ${tagging ? "cursor-crosshair" : ""}`} data-testid="photo-tag-surface">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} className="w-full rounded-theme bg-surface-alt select-none" draggable={false} />
        {show &&
          tags.map((t) => (
            <span
              key={t.id}
              data-testid="photo-tag"
              className="absolute rounded-sm border-2 border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,.45)]"
              style={{ left: `${t.box[0] * 100}%`, top: `${t.box[1] * 100}%`, width: `${t.box[2] * 100}%`, height: `${t.box[3] * 100}%` }}
            >
              <span className="absolute left-0 top-full mt-0.5 whitespace-nowrap rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-white">
                {t.name}
                {canEdit && t.hand && (
                  <button
                    type="button"
                    aria-label={`Remove the tag for ${t.name}`}
                    disabled={busy}
                    className="ml-1 hover:text-red-300"
                    onClick={(e) => {
                      e.stopPropagation();
                      start(async () => {
                        await untagPersonAt(t.id);
                        router.refresh();
                      });
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            </span>
          ))}
        {placed && (
          <span
            className="absolute rounded-sm border-2 border-primary bg-primary/10"
            style={{ left: `${placed[0] * 100}%`, top: `${placed[1] * 100}%`, width: `${placed[2] * 100}%`, height: `${placed[3] * 100}%` }}
          />
        )}
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {!tagging ? (
            <button type="button" className="text-primary hover:underline text-xs" onClick={() => setTagging(true)} data-testid="tag-someone">
              Tag someone
            </button>
          ) : !placed ? (
            <>
              <span className="text-xs text-muted">Point at somebody in the picture.</span>
              <button type="button" className="text-primary hover:underline text-xs" onClick={() => setTagging(false)}>Done</button>
            </>
          ) : (
            <>
              <Select value={choice} onChange={(e) => setChoice(e.target.value)} className="h-8 text-xs w-auto" aria-label="Who is this?">
                <option value="">Somebody new…</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
              {!choice && (
                <input
                  value={fresh}
                  onChange={(e) => setFresh(e.target.value)}
                  placeholder="Their name"
                  aria-label="Their name"
                  maxLength={80}
                  className="h-8 w-40 rounded-theme border border-border px-2 text-xs"
                />
              )}
              <Button size="sm" disabled={busy || (!choice && !fresh.trim())} onClick={save}>Tag</Button>
              <button type="button" className="text-muted hover:underline text-xs" onClick={() => setPlaced(null)}>Cancel</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
