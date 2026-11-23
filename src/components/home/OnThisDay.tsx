"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Found = {
  id: string;
  year: number;
  title: string | null;
  caption: string | null;
  trip: { slug: string; title: string | null } | null;
  thumb: string;
};

/** The viewer's own calendar day, as the browser's clock has it: the server cannot know it. */
function localToday(now = new Date()): { iso: string; year: number; label: string } {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    iso: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    year: now.getFullYear(),
    label: now.toLocaleDateString("en-US", { month: "long", day: "numeric" }),
  };
}

function ago(year: number, thisYear: number): string {
  const n = thisYear - year;
  return n === 1 ? "Last year" : `${n} years ago`;
}

/**
 * Photographs from this day of the year in earlier years, a row at the top of the front page. Nothing at all on a
 * day the family took no pictures in any earlier year, and nothing while it is being asked: a heading over an empty
 * row is a promise the page cannot keep.
 */
export function OnThisDay() {
  const [found, setFound] = useState<{ photos: Found[]; year: number; label: string } | null>(null);
  useEffect(() => {
    const today = localToday();
    let live = true;
    fetch(`/api/on-this-day?date=${today.iso}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { photos: Found[] } | null) => {
        if (live && body?.photos?.length) setFound({ photos: body.photos, year: today.year, label: today.label });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  if (!found) return null;

  const years = [...new Set(found.photos.map((p) => p.year))];
  return (
    <section className="mb-12" aria-labelledby="on-this-day" data-testid="on-this-day">
      <h2 id="on-this-day" className="font-display text-3xl font-semibold">On this day</h2>
      <p className="text-muted mt-1 text-lg">{found.label}, in years gone by.</p>
      <div className="mt-5 space-y-6">
        {years.map((year) => {
          const photos = found.photos.filter((p) => p.year === year);
          const trips = [...new Map(photos.filter((p) => p.trip).map((p) => [p.trip!.slug, p.trip!])).values()];
          return (
            <div key={year}>
              <h3 className="text-xl font-semibold">
                {ago(year, found.year)} <span className="text-muted font-normal">· {year}</span>
                {trips.map((t) => (
                  <span key={t.slug} className="font-normal">
                    {" · "}
                    <Link href={`/trips/${t.slug}`} className="text-primary underline underline-offset-2">{t.title}</Link>
                  </span>
                ))}
              </h3>
              <ul className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {photos.map((p) => (
                  <li key={p.id}>
                    <Link href={`/photos/${p.id}`} className="block overflow-hidden rounded-theme bg-surface-alt focus:outline-none focus:ring-2 focus:ring-ring">
                      {/* eslint-disable-next-line @next/next/no-img-element -- the album's own thumbnails, already sized */}
                      <img src={p.thumb} alt={p.title ?? p.caption ?? `A photo from ${year}`} loading="lazy" className="aspect-square w-full object-cover transition-transform hover:scale-105" />
                    </Link>
                    {(p.title || p.caption) && <p className="mt-1 text-base line-clamp-2">{p.title ?? p.caption}</p>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}
