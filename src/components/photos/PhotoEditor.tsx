"use client";

import { useCallback, useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Label } from "@/components/ui";
import { LEVELS_SAMPLE_WIDTH, NEUTRAL, contrastTerms, hasEdits, levelsOfRegion, warmthChannels, type PhotoEdits } from "@/lib/images/edits";
import { savePhotoEdits } from "@/app/photos/[id]/actions";

type Crop = { x: number; y: number; w: number; h: number };
const FULL: Crop = { x: 0, y: 0, w: 1, h: 1 };
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * The darkroom. Everything it offers is framing and light — crop, straighten, mirror, brightness, contrast, colour —
 * so an edited photo still shows what was in front of the lens; nothing here can add, remove or move anything in the
 * picture. The preview runs the same numbers the server will: the colour matrix below is the warmth and contrast
 * from `edits.ts`, so what a member sees while dragging a slider is what comes back.
 */
export function PhotoEditor({ photoId, src, initial, onDone }: { photoId: string; src: string; initial: PhotoEdits | null; onDone?: () => void }) {
  const router = useRouter();
  const filterId = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const [edits, setEdits] = useState<PhotoEdits>(initial ?? {});
  const [cropping, setCropping] = useState(false);
  const [crop, setCrop] = useState<Crop>(initial?.crop ?? FULL);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const set = <K extends keyof PhotoEdits>(k: K, v: PhotoEdits[K]) => setEdits((e) => ({ ...e, [k]: v }));
  // Measured from the picture on screen once it has loaded, so the auto-levels preview is the real stretch for this
  // photograph rather than a guess. The server measures the full-size original, so the two can differ a shade.
  const [levels, setLevels] = useState<{ mul: number; off: number } | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const brightness = edits.brightness ?? NEUTRAL.brightness;
  const contrast = edits.contrast ?? NEUTRAL.contrast;
  const saturation = edits.saturation ?? NEUTRAL.saturation;
  const warmth = edits.warmth ?? NEUTRAL.warmth;
  const rotate = edits.rotate ?? 0;

  // Auto levels, then warmth and contrast, in the order the server applies them. Two straight lines one after the
  // other are one straight line, so both fold into a single colour matrix: multiply by (warmth · contrast · levels),
  // then add the levels offset carried through the second multiply, plus contrast's own mid-grey offset.
  const [wr, wg, wb] = warmthChannels(warmth);
  const { mul, off } = contrastTerms(contrast);
  const auto = edits.auto ? levels : null;
  const channel = (w: number) => w * mul * (auto?.mul ?? 1);
  const offsetFor = (w: number) => (w * mul * (auto?.off ?? 0) + off) / 255;
  const matrix = [
    channel(wr), 0, 0, 0, offsetFor(wr),
    0, channel(wg), 0, 0, offsetFor(wg),
    0, 0, channel(wb), 0, offsetFor(wb),
    0, 0, 0, 1, 0,
  ].join(" ");
  const draft: PhotoEdits = { ...edits, crop: crop.w < 1 || crop.h < 1 || crop.x > 0 || crop.y > 0 ? crop : undefined };

  // The small copy is read once per picture; the levels of whatever the crop keeps are then pure arithmetic over it,
  // which is what lets this run while a crop is being dragged without the editor stuttering.
  const sample = useRef<ImageData | null>(null);
  const read = useCallback(() => {
    const img = imgRef.current;
    sample.current = img?.complete ? samplePixels(img) : null;
    setLevels(sample.current ? levelsOfRegion(sample.current, FULL) : null);
  }, []);
  useEffect(() => { read(); }, [read, src]);
  useEffect(() => {
    if (sample.current) setLevels(levelsOfRegion(sample.current, crop));
  }, [crop]);

  const save = () => start(async () => {
    setMessage(null);
    const r = await savePhotoEdits(photoId, draft);
    if (!r.ok) { setMessage(r.message); return; }
    router.refresh();
    onDone?.();
  });
  const revert = () => start(async () => {
    setMessage(null);
    const r = await savePhotoEdits(photoId, {});
    if (!r.ok) { setMessage(r.message); return; }
    setEdits({});
    setCrop(FULL);
    router.refresh();
    onDone?.();
  });

  return (
    <div className="space-y-4" data-testid="photo-editor">
      <svg aria-hidden width="0" height="0" className="absolute">
        <filter id={filterId} colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values={matrix} />
        </filter>
      </svg>

      <div className="relative bg-surface-alt rounded-theme overflow-hidden grid place-items-center" style={{ minHeight: 240 }}>
        <div style={{ transform: `rotate(${rotate}deg) scaleX(${edits.flip ? -1 : 1})`, transition: "transform 150ms" }} className="max-w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt="The photo as it will look"
            className="max-h-[50vh] max-w-full object-contain block"
            style={{ filter: `url(#${filterId}) brightness(${brightness}) saturate(${saturation})` }}
            ref={imgRef}
            onLoad={() => read()}
          />
        </div>
        {cropping && <CropOverlay crop={crop} onChange={setCrop} />}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => set("rotate", (((rotate + 270) % 360) as 0 | 90 | 180 | 270))}>Turn left</Button>
        <Button size="sm" variant="secondary" onClick={() => set("rotate", (((rotate + 90) % 360) as 0 | 90 | 180 | 270))}>Turn right</Button>
        <Button size="sm" variant={edits.flip ? "primary" : "secondary"} onClick={() => set("flip", !edits.flip)}>Mirror</Button>
        <Button size="sm" variant={cropping ? "primary" : "secondary"} onClick={() => setCropping((c) => !c)}>{cropping ? "Done cropping" : "Crop"}</Button>
        {(crop.w < 1 || crop.h < 1) && <Button size="sm" variant="ghost" onClick={() => setCrop(FULL)}>Whole picture</Button>}
        <Button size="sm" variant={edits.auto ? "primary" : "secondary"} onClick={() => set("auto", !edits.auto)}>Auto levels</Button>
        <Button size="sm" variant={edits.sharpen ? "primary" : "secondary"} onClick={() => set("sharpen", !edits.sharpen)}>Sharpen</Button>
      </div>
      {(edits.auto && !levels) || edits.sharpen ? (
        <p className="text-xs text-muted">
          {edits.sharpen ? "Sharpening is applied when you save; it is too fine to show at this size. " : ""}
          {edits.auto && !levels ? "There is nothing here for auto levels to stretch, so it will leave this photo as it is." : ""}
        </p>
      ) : null}

      <div className="grid sm:grid-cols-2 gap-x-6 gap-y-3">
        <Slider label="Brightness" value={brightness} min={0.4} max={1.8} step={0.02} neutral={1} onChange={(v) => set("brightness", v)} />
        <Slider label="Contrast" value={contrast} min={0.4} max={1.8} step={0.02} neutral={1} onChange={(v) => set("contrast", v)} />
        <Slider label="Color" value={saturation} min={0} max={2} step={0.02} neutral={1} onChange={(v) => set("saturation", v)} />
        <Slider label="Warmth" value={warmth} min={-100} max={100} step={2} neutral={0} onChange={(v) => set("warmth", v)} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={pending}>{pending ? "Saving…" : "Save edits"}</Button>
        <Button size="sm" variant="secondary" onClick={revert} disabled={pending || !hasEdits(draft)}>Back to the original</Button>
        {onDone && <Button size="sm" variant="ghost" onClick={onDone}>Close</Button>}
        <span className="text-xs text-muted">The file you uploaded is never changed; it stays one click away.</span>
      </div>
      {message && <p role="alert" className="text-sm text-red-800">{message}</p>}
    </div>
  );
}

/**
 * A small copy of the picture, read once, for the levels to be measured from. Everything after that is arithmetic
 * over this array: dragging a crop re-measures without touching the image, the canvas or the DOM again.
 */
function samplePixels(img: HTMLImageElement): ImageData | null {
  try {
    const natural = { w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
    if (!natural.w || !natural.h) return null;
    const width = Math.max(1, Math.round(Math.min(LEVELS_SAMPLE_WIDTH, natural.w)));
    const height = Math.max(1, Math.round((natural.h / natural.w) * width));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } catch {
    // A canvas the browser will not let us read (it should be same-origin, but never break the editor over it).
    return null;
  }
}

function Slider({ label, value, min, max, step, neutral, onChange }: { label: string; value: number; min: number; max: number; step: number; neutral: number; onChange: (v: number) => void }) {
  const id = useId();
  return (
    <div>
      <div className="flex items-center justify-between">
        <Label htmlFor={id} className="mb-0">{label}</Label>
        <button type="button" className="text-xs text-muted hover:underline" onClick={() => onChange(neutral)} disabled={value === neutral}>reset</button>
      </div>
      <input id={id} type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full" aria-label={label} />
    </div>
  );
}

/** Drag inside to move the frame, drag a corner to resize it. Values are fractions, so they survive any re-render. */
function CropOverlay({ crop, onChange }: { crop: Crop; onChange: (c: Crop) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: "move" | "nw" | "ne" | "sw" | "se"; x: number; y: number; start: Crop } | null>(null);

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current, box = ref.current?.getBoundingClientRect();
      if (!d || !box) return;
      const dx = (e.clientX - d.x) / box.width;
      const dy = (e.clientY - d.y) / box.height;
      const s = d.start;
      if (d.kind === "move") {
        onChange({ ...s, x: clamp01(Math.min(s.x + dx, 1 - s.w)), y: clamp01(Math.min(s.y + dy, 1 - s.h)) });
        return;
      }
      const left = d.kind === "nw" || d.kind === "sw";
      const top = d.kind === "nw" || d.kind === "ne";
      const x = left ? clamp01(Math.min(s.x + dx, s.x + s.w - 0.05)) : s.x;
      const y = top ? clamp01(Math.min(s.y + dy, s.y + s.h - 0.05)) : s.y;
      const w = left ? s.x + s.w - x : Math.max(0.05, Math.min(1 - s.x, s.w + dx));
      const h = top ? s.y + s.h - y : Math.max(0.05, Math.min(1 - s.y, s.h + dy));
      onChange({ x, y, w, h });
    };
    const up = () => { drag.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, [onChange]);

  // One handler for the frame and its four corners; which one was grabbed comes off the element itself, so nothing
  // touches the ref while the component is rendering.
  const begin = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      const kind = (e.currentTarget.dataset.handle ?? "move") as "move" | "nw" | "ne" | "sw" | "se";
      drag.current = { kind, x: e.clientX, y: e.clientY, start: crop };
    },
    [crop],
  );
  const handle = "absolute w-4 h-4 bg-white border border-black/40 rounded-sm touch-none";

  return (
    <div ref={ref} className="absolute inset-0" data-testid="crop-overlay">
      <div className="absolute inset-0 bg-black/50" style={{ clipPath: `polygon(0% 0%, 0% 100%, ${crop.x * 100}% 100%, ${crop.x * 100}% ${crop.y * 100}%, ${(crop.x + crop.w) * 100}% ${crop.y * 100}%, ${(crop.x + crop.w) * 100}% ${(crop.y + crop.h) * 100}%, ${crop.x * 100}% ${(crop.y + crop.h) * 100}%, ${crop.x * 100}% 100%, 100% 100%, 100% 0%)` }} />
      <div
        className="absolute border-2 border-white cursor-move touch-none"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
        data-handle="move"
        onPointerDown={begin}
      >
        <span className={`${handle} -left-2 -top-2 cursor-nwse-resize`} data-handle="nw" onPointerDown={begin} />
        <span className={`${handle} -right-2 -top-2 cursor-nesw-resize`} data-handle="ne" onPointerDown={begin} />
        <span className={`${handle} -left-2 -bottom-2 cursor-nesw-resize`} data-handle="sw" onPointerDown={begin} />
        <span className={`${handle} -right-2 -bottom-2 cursor-nwse-resize`} data-handle="se" onPointerDown={begin} />
      </div>
    </div>
  );
}
