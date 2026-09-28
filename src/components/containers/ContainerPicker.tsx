"use client";

import { useCallback, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import type { ContainerHit } from "@/app/api/containers/route";

export type Container = { id: string; title: string; slug?: string; visibility?: string };
export type ContainerKind = "trip" | "collection" | "activity";

const WORD = { trip: { one: "trip", many: "trips" }, collection: { one: "collection", many: "collections" }, activity: { one: "activity", many: "activities" } } as const;

/** Wait this long after the last keystroke before asking the server, so typing a title is one request, not ten. */
const DEBOUNCE_MS = 180;

/** Which search a set of results answers, so results for what was typed a moment ago are never taken for these. */
export const searchKey = (kind: ContainerKind, query: string, tripId?: string) => `${kind}\u0000${tripId ?? ""}\u0000${query}`;

/** `onArrive` hears each answer as it lands, so an Enter pressed before it did can be carried out against it. */
function useSearch(kind: ContainerKind, query: string, open: boolean, tripId?: string, onArrive?: (hits: ContainerHit[]) => void) {
  const [result, setResult] = useState<{ key: string; hits: ContainerHit[] }>({ key: "", hits: [] });
  const [loading, setLoading] = useState(false);
  const key = searchKey(kind, query, tripId);
  const arrived = useEffectEvent((hits: ContainerHit[]) => onArrive?.(hits));
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(`/api/containers?kind=${kind}&q=${encodeURIComponent(query)}${tripId ? `&trip=${encodeURIComponent(tripId)}` : ""}`, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : { hits: [] }))
        .then((j: { hits: ContainerHit[] }) => { if (live) { setResult({ key, hits: j.hits ?? [] }); arrived(j.hits ?? []); } })
        .catch(() => { if (live) { setResult({ key, hits: [] }); arrived([]); } })
        .finally(() => { if (live) setLoading(false); });
    }, query ? DEBOUNCE_MS : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [kind, query, open, tripId, key]);
  // Until the answer to this query arrives, the last one is still shown but cannot be picked from with Enter.
  const fresh = result.key === key;
  return { hits: result.hits, loading: loading || !fresh, fresh };
}

/** Focus has gone somewhere outside the picker — tabbed past it, say — so its list should not stay open over what follows. */
export function leftFor(box: { contains: (n: Node | null) => boolean } | null, next: EventTarget | null): boolean {
  return !box || !next || !box.contains(next as Node);
}

/**
 * What Enter does in the single picker. The search results are still loading when `fresh` is false; what is shown
 * meanwhile is the last answer, with the fixed choices ("No trip", and any extras) under it.
 *
 * - On a fixed choice the reader reached with the arrow keys, it is that choice: it does not depend on the search,
 *   so there is nothing to wait for.
 * - Otherwise, while loading, it waits for the answer to what was typed (and is carried out against it).
 * - Loaded, it is the result or fixed choice that is active.
 *
 * A fixed choice that is active only because the last answer was empty — typed, then Enter at once — is not one the
 * reader chose, and waits like any other.
 */
export function enterChoice(s: { active: number; hits: number; tail: number; fresh: boolean; byKeys: boolean }): { pick: "hit" | "tail"; index: number } | { pick: "wait" } | null {
  const onTail = s.active >= s.hits && s.active - s.hits < s.tail;
  if (onTail && (s.fresh || s.byKeys)) return { pick: "tail", index: s.active - s.hits };
  if (!s.fresh) return { pick: "wait" };
  return s.active >= 0 && s.active < s.hits ? { pick: "hit", index: s.active } : null;
}

function visibilityNote(v?: string): string | null {
  return v === "PUBLIC" ? "public" : v === "LINK" ? "shared by link" : null;
}

/** The shared listbox: search results with keyboard movement, used by both pickers below. */
function Results({ hits, loading, kind, active, onPick, exclude, listId, emptyNote }: { hits: ContainerHit[]; loading: boolean; kind: ContainerKind; active: number; onPick: (h: ContainerHit) => void; exclude: Set<string>; listId: string; emptyNote?: string }) {
  const shown = hits.filter((h) => !exclude.has(h.id));
  if (loading && !shown.length) return <li className="px-3 py-2 text-sm text-muted">Looking…</li>;
  if (!shown.length) return <li className="px-3 py-2 text-sm text-muted">{emptyNote ?? `No ${WORD[kind].many} match that.`}</li>;
  return (
    <>
      {shown.map((h, i) => (
        <li key={h.id} id={`${listId}-${i}`} role="option" aria-selected={i === active}>
          {/* Out of the Tab order, as a listbox's options are: the arrows move through them while focus stays in the box,
              so Tab leaves the picker (and closes the list) rather than stepping into it. */}
          <button
            type="button"
            tabIndex={-1}
            className={`w-full text-left px-3 py-2 text-sm flex items-baseline gap-2 ${i === active ? "bg-surface-alt" : "hover:bg-surface-alt"}`}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(h)}
          >
            <span className="flex-1 truncate">{h.title}</span>
            {h.when && <span className="text-xs text-muted shrink-0">{h.when}</span>}
            <span className="text-xs text-muted shrink-0">{h.items}</span>
            {visibilityNote(h.visibility) && <span className="text-xs text-muted shrink-0">{visibilityNote(h.visibility)}</span>}
          </button>
        </li>
      ))}
    </>
  );
}

/**
 * Pick one trip or collection by name. A dropdown holding every one of them stops being usable somewhere around the
 * fiftieth: this asks the server as you type and shows a shortlist, so it reads the same with five or five hundred.
 * With the box empty it offers the most recent, which is what people reach for most of the time.
 */
export function ContainerPicker({ kind, value, onChange, placeholder, allowNone, noneLabel, name, extras = [], className, tripId }: {
  kind: ContainerKind;
  /** Which trip's activities to search, for kind="activity". */
  tripId?: string;
  value: Container | null;
  onChange: (v: Container | null) => void;
  placeholder?: string;
  /** Offer an explicit "no trip" choice (moving photos off a trip is a real thing to want). */
  allowNone?: boolean;
  noneLabel?: string;
  /** Render a hidden input of this name, so the picker works inside a plain form. */
  name?: string;
  /** Choices that are not containers — "without a trip", say — offered under the search results. */
  extras?: Container[];
  className?: string;
}) {
  const listId = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const choose = useCallback((v: Container | null) => { onChange(v); setOpen(false); setQuery(""); }, [onChange]);
  // An Enter pressed before the answer to what was typed has come back, carried out when it does.
  const pendingEnter = useRef(false);
  // Whether the active option was reached with the arrow keys since the box last changed (see `enterChoice`).
  const byKeys = useRef(false);
  const { hits, loading, fresh } = useSearch(kind, query, open, tripId, (arrived) => {
    if (!pendingEnter.current) return;
    pendingEnter.current = false;
    // Only a real match: an empty answer leaves the list open rather than choosing "No trip" for the reader.
    const h = arrived[active];
    if (h) choose({ id: h.id, title: h.title, slug: h.slug, visibility: h.visibility });
  });

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const tail: (Container | null)[] = [...extras, ...(allowNone ? [null] : [])];
  const options = hits.length + tail.length;

  return (
    <div ref={box} className={`relative ${className ?? ""}`} data-testid={`${kind}-picker`} onBlur={(e) => { if (!leftFor(box.current, e.relatedTarget)) return; pendingEnter.current = false; setOpen(false); }}>
      {name && <input type="hidden" name={name} value={value?.id ?? ""} />}
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && fresh && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={placeholder ?? `Search ${WORD[kind].many}`}
        className="h-8 w-full rounded border border-border bg-surface px-2 text-sm"
        placeholder={value ? value.title : placeholder ?? `Search ${WORD[kind].many}…`}
        value={open ? query : value?.title ?? ""}
        onFocus={() => { byKeys.current = false; setOpen(true); setActive(0); }}
        onChange={(e) => { pendingEnter.current = false; byKeys.current = false; setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); byKeys.current = true; setOpen(true); setActive((a) => Math.min(a + 1, options - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); byKeys.current = true; setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open) {
            e.preventDefault();
            // Enter straight after typing waits for the answer to what was typed, not the list before it; a fixed
            // choice picked with the arrows is carried out at once.
            const what = enterChoice({ active, hits: hits.length, tail: tail.length, fresh, byKeys: byKeys.current });
            if (!what) return;
            if (what.pick === "wait") { pendingEnter.current = true; return; }
            pendingEnter.current = false;
            if (what.pick === "tail") choose(tail[what.index] ?? null);
            else choose(hits[what.index]);
          } else if (e.key === "Escape") { pendingEnter.current = false; setOpen(false); setQuery(""); }
        }}
      />
      {value && !open && (
        <button type="button" className="absolute right-1 top-1 px-1.5 text-muted hover:text-text text-sm" aria-label={`Clear the ${WORD[kind].one}`} onClick={() => choose(null)}>×</button>
      )}
      {open && (
        <ul id={listId} role="listbox" aria-busy={loading} onMouseDown={(e) => e.preventDefault()} className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-theme border border-border bg-surface shadow-lg divide-y divide-border">
          <Results hits={hits} loading={loading} kind={kind} active={active} onPick={(h) => choose({ id: h.id, title: h.title, slug: h.slug, visibility: h.visibility })} exclude={new Set()} listId={listId} />
          {tail.map((t, i) => {
            const at = hits.length + i;
            return (
              <li key={t?.id ?? "__none"} id={`${listId}-${at}`} role="option" aria-selected={active === at}>
                <button type="button" tabIndex={-1} className={`w-full text-left px-3 py-2 text-sm ${active === at ? "bg-surface-alt" : "hover:bg-surface-alt"}`} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(t)}>
                  {t ? t.title : noneLabel ?? `No ${WORD[kind].one}`}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Pick any number of them. What an item already belongs to is shown as chips that can be taken off, and the same
 * search adds more — so the form is as short as the answer rather than as long as the library.
 */
export function ContainerMultiPicker({ kind, value, onChange, name, hint }: {
  kind: ContainerKind;
  value: Container[];
  onChange: (v: Container[]) => void;
  /** Each chosen one is submitted under this name, so a plain form action reads them as it always did. */
  name: string;
  hint?: string;
}) {
  const listId = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const pendingEnter = useRef(false);
  const chosen = new Set(value.map((v) => v.id));
  const add = (h: ContainerHit) => {
    if (!chosen.has(h.id)) onChange([...value, { id: h.id, title: h.title, slug: h.slug, visibility: h.visibility }]);
    setQuery("");
    setActive(0);
  };
  const { hits, loading, fresh } = useSearch(kind, query, open, undefined, (arrived) => {
    if (!pendingEnter.current) return;
    pendingEnter.current = false;
    const h = arrived.filter((x) => !chosen.has(x.id))[active];
    if (h) add(h);
  });

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const remaining = hits.filter((h) => !chosen.has(h.id));

  return (
    <div ref={box} className="relative space-y-2" data-testid={`${kind}-multi-picker`} onBlur={(e) => { if (!leftFor(box.current, e.relatedTarget)) return; pendingEnter.current = false; setOpen(false); }}>
      {value.map((v) => <input key={v.id} type="hidden" name={name} value={v.id} />)}
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Chosen ${WORD[kind].many}`}>
          {value.map((v) => (
            <li key={v.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-alt px-2 py-0.5 text-sm">
              {/* A chip is also the way in: this is often the quickest route to the collection the item is in. */}
              {v.slug ? <a href={`/${kind === "trip" ? "trips" : "collections"}/${v.slug}`} className="text-primary hover:underline">{v.title}</a> : <span>{v.title}</span>}
              {visibilityNote(v.visibility) && <span className="text-xs text-muted">({visibilityNote(v.visibility)})</span>}
              <button type="button" aria-label={`Remove ${v.title}`} className="text-muted hover:text-text" onClick={() => onChange(value.filter((x) => x.id !== v.id))}>×</button>
            </li>
          ))}
        </ul>
      )}
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && fresh && remaining[active] ? `${listId}-${active}` : undefined}
        aria-label={`Add to a ${WORD[kind].one}`}
        className="h-8 w-full rounded border border-border bg-surface px-2 text-sm"
        placeholder={value.length ? `Add another ${WORD[kind].one}…` : `Search ${WORD[kind].many}…`}
        value={query}
        onFocus={() => { setOpen(true); setActive(0); }}
        onChange={(e) => { pendingEnter.current = false; setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, remaining.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && !fresh) { e.preventDefault(); pendingEnter.current = true; }
          else if (e.key === "Enter" && open && remaining[active]) { e.preventDefault(); add(remaining[active]); }
          else if (e.key === "Escape") { pendingEnter.current = false; setOpen(false); setQuery(""); }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" aria-busy={loading} onMouseDown={(e) => e.preventDefault()} className="absolute z-20 w-full max-h-64 overflow-y-auto rounded-theme border border-border bg-surface shadow-lg divide-y divide-border">
          <Results hits={hits} loading={loading} kind={kind} active={active} onPick={add} exclude={chosen} listId={listId} emptyNote={query ? undefined : `Every ${WORD[kind].one} is already chosen.`} />
        </ul>
      )}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
