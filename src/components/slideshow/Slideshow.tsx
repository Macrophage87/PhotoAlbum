"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Slide } from "@/lib/photos/slideshow";

/** Seconds a picture stays up. "Slow" is the default: there is time to read the caption and to talk about it. */
export const SPEEDS = [
  { label: "Slow", seconds: 10 },
  { label: "Medium", seconds: 6 },
  { label: "Fast", seconds: 3 },
] as const;

const SPEED_KEY = "slideshow-speed";

/** Which slide comes next, going round again at the end so it can be left playing on a television. */
export function step(index: number, by: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + by) % count) + count) % count;
}

type WakeLock = { release: () => Promise<void> };

/**
 * A trip or a collection shown one picture at a time, filling the screen: for sitting together on the sofa, or for
 * a grandparent who would rather watch than click. It moves on by itself, and every control is a large, labelled
 * button as well as a key (arrows, space, Escape, F), so nobody has to know the keys to use it.
 */
export function Slideshow({ title, slides, closeHref }: { title: string; slides: Slide[]; closeHref: string }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(slides.length > 1);
  // The speed someone chose is kept on this device: whoever turned it down will want it down next time too.
  const [speed, setSpeed] = useState<number>(() => {
    try {
      const saved = typeof window === "undefined" ? NaN : Number(localStorage.getItem(SPEED_KEY));
      return SPEEDS.some((s) => s.seconds === saved) ? saved : SPEEDS[0].seconds;
    } catch {
      return SPEEDS[0].seconds;
    }
  });
  const [loaded, setLoaded] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const count = slides.length;
  const slide = slides[index];

  const chooseSpeed = (seconds: number) => {
    setSpeed(seconds);
    try {
      localStorage.setItem(SPEED_KEY, String(seconds));
    } catch {}
  };

  const go = useCallback((by: number) => setIndex((i) => step(i, by, count)), [count]);

  // Moving on by itself: the clock starts again whenever the picture changes, so pressing Next never cuts one short.
  useEffect(() => {
    if (!playing || count < 2) return;
    const t = setTimeout(() => go(1), speed * 1000);
    return () => clearTimeout(t);
  }, [playing, speed, index, count, go]);

  // The next picture is fetched while this one is up, so the change is a fade and not a blank screen.
  useEffect(() => {
    const next = slides[step(index, 1, count)];
    if (next && count > 1) {
      const img = new Image();
      img.src = next.src;
    }
  }, [index, count, slides]);

  // While it plays, the screen is asked not to go dark (where the browser allows it).
  useEffect(() => {
    if (!playing) return;
    let lock: WakeLock | null = null;
    let cancelled = false;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: "screen") => Promise<WakeLock> } };
    nav.wakeLock?.request("screen").then(
      (l) => (cancelled ? void l.release().catch(() => {}) : (lock = l)),
      () => {},
    );
    return () => {
      cancelled = true;
      lock?.release().catch(() => {});
    };
  }, [playing]);

  useEffect(() => {
    const onChange = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFull = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void root.current?.requestFullscreen?.().catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      // A button that has the focus answers Space and Enter itself.
      if ((e.key === " " || e.key === "Enter") && (e.target as HTMLElement | null)?.closest("button, a, select")) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
      else if (e.key === " ") setPlaying((p) => !p);
      else if (e.key === "f" || e.key === "F") toggleFull();
      else if (e.key === "Escape" && !document.fullscreenElement) window.location.assign(closeHref);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, toggleFull, closeHref]);

  const button = "min-h-12 rounded-theme bg-white/15 px-4 py-2 text-lg font-semibold text-white hover:bg-white/25 focus:outline-none focus:ring-4 focus:ring-white/70 disabled:opacity-40";

  return (
    <div ref={root} className="fixed inset-0 z-[60] flex flex-col bg-black text-white" role="region" aria-label={`Slideshow: ${title}`} data-testid="slideshow">
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <h1 className="truncate text-xl font-semibold">{title}</h1>
        <Link href={closeHref} className={button} data-testid="slideshow-close">
          Close
        </Link>
      </div>

      <div className="relative flex-1 min-h-0">
        {slide ? (
          // eslint-disable-next-line @next/next/no-img-element -- the album's own copies, already sized
          <img
            key={slide.id}
            src={slide.src}
            alt={slide.title ?? slide.caption ?? `Photo ${index + 1} of ${count}`}
            onLoad={() => setLoaded(slide.id)}
            // A picture the browser already had (or finished before the page came alive) fires no load event.
            ref={(el) => {
              if (el?.complete && el.naturalWidth > 0 && loaded !== slide.id) setLoaded(slide.id);
            }}
            className={`absolute inset-0 m-auto max-h-full max-w-full object-contain transition-opacity duration-700 ${loaded === slide.id ? "opacity-100" : "opacity-0"}`}
            data-testid="slideshow-image"
          />
        ) : (
          <p className="absolute inset-0 m-auto h-fit text-center text-2xl">There are no photos to show here yet.</p>
        )}
      </div>

      <div className="bg-black/80 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        {slide && (
          <div className="mx-auto max-w-4xl text-center" aria-live={playing ? "off" : "polite"}>
            {(slide.title || slide.caption) && <p className="text-2xl font-semibold leading-snug" data-testid="slideshow-caption">{slide.title ?? slide.caption}</p>}
            {slide.title && slide.caption && <p className="mt-1 text-xl">{slide.caption}</p>}
            {(slide.day || slide.place) && <p className="mt-1 text-lg text-white/85">{[slide.day, slide.place].filter(Boolean).join(" · ")}</p>}
          </div>
        )}
        <div className="mx-auto mt-3 flex max-w-4xl flex-wrap items-center justify-center gap-2">
          <button type="button" className={button} onClick={() => go(-1)} disabled={count < 2} aria-label="Previous photo">
            ← Previous
          </button>
          <button type="button" className={`${button} min-w-28`} onClick={() => setPlaying((p) => !p)} disabled={count < 2} data-testid="slideshow-play">
            {playing ? "Pause" : "Play"}
          </button>
          <button type="button" className={button} onClick={() => go(1)} disabled={count < 2} aria-label="Next photo" data-testid="slideshow-next">
            Next →
          </button>
          <label className="flex items-center gap-2 text-lg">
            <span className="sr-only sm:not-sr-only">Speed</span>
            <select value={speed} onChange={(e) => chooseSpeed(Number(e.target.value))} className="min-h-12 rounded-theme bg-white/15 px-3 text-lg text-white focus:outline-none focus:ring-4 focus:ring-white/70" aria-label="How long each photo stays up">
              {SPEEDS.map((s) => (
                <option key={s.seconds} value={s.seconds} className="text-black">
                  {s.label} ({s.seconds} seconds)
                </option>
              ))}
            </select>
          </label>
          <button type="button" className={button} onClick={toggleFull}>
            {full ? "Leave full screen" : "Full screen"}
          </button>
          {count > 0 && <span className="px-2 text-lg text-white/85" data-testid="slideshow-count">{index + 1} of {count}</span>}
        </div>
      </div>
    </div>
  );
}
