"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ContainerHit } from "@/app/api/containers/route";

export type Container = { id: string; title: string; slug?: string; visibility?: string };
export type ContainerKind = "trip" | "collection";

const WORD = { trip: { one: "trip", many: "trips" }, collection: { one: "collection", many: "collections" } } as const;

/** Wait this long after the last keystroke before asking the server, so typing a title is one request, not ten. */
const DEBOUNCE_MS = 180;

function useSearch(kind: ContainerKind, query: string, open: boolean) {
  const [hits, setHits] = useState<ContainerHit[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    const timer = setTimeout(() => {
      setLoading(true);
      fetch(`/api/containers?kind=${kind}&q=${encodeURIComponent(query)}`, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : { hits: [] }))
        .then((j: { hits: ContainerHit[] }) => { if (live) setHits(j.hits ?? []); })
        .catch(() => { if (live) setHits([]); })
        .finally(() => { if (live) setLoading(false); });
    }, query ? DEBOUNCE_MS : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [kind, query, open]);
  return { hits, loading };
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
          <button
            type="button"
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
export function ContainerPicker({ kind, value, onChange, placeholder, allowNone, noneLabel, name, extras = [], className }: {
  kind: ContainerKind;
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
  const { hits, loading } = useSearch(kind, query, open);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const choose = useCallback((v: Container | null) => { onChange(v); setOpen(false); setQuery(""); }, [onChange]);
  const tail: (Container | null)[] = [...extras, ...(allowNone ? [null] : [])];
  const options = hits.length + tail.length;

  return (
    <div ref={box} className={`relative ${className ?? ""}`} data-testid={`${kind}-picker`}>
      {name && <input type="hidden" name={name} value={value?.id ?? ""} />}
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-label={placeholder ?? `Search ${WORD[kind].many}`}
        className="h-8 w-full rounded border border-border bg-surface px-2 text-sm"
        placeholder={value ? value.title : placeholder ?? `Search ${WORD[kind].many}…`}
        value={open ? query : value?.title ?? ""}
        onFocus={() => { setOpen(true); setActive(0); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, options - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open) {
            e.preventDefault();
            if (active >= hits.length) choose(tail[active - hits.length] ?? null);
            else if (hits[active]) choose(hits[active]);
          } else if (e.key === "Escape") { setOpen(false); setQuery(""); }
        }}
      />
      {value && !open && (
        <button type="button" className="absolute right-1 top-1 px-1.5 text-muted hover:text-foreground text-sm" aria-label={`Clear the ${WORD[kind].one}`} onClick={() => choose(null)}>×</button>
      )}
      {open && (
        <ul id={listId} role="listbox" className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto rounded-theme border border-border bg-surface shadow-lg divide-y divide-border">
          <Results hits={hits} loading={loading} kind={kind} active={active} onPick={(h) => choose({ id: h.id, title: h.title, slug: h.slug, visibility: h.visibility })} exclude={new Set()} listId={listId} />
          {tail.map((t, i) => {
            const at = hits.length + i;
            return (
              <li key={t?.id ?? "__none"} id={`${listId}-${at}`} role="option" aria-selected={active === at}>
                <button type="button" className={`w-full text-left px-3 py-2 text-sm ${active === at ? "bg-surface-alt" : "hover:bg-surface-alt"}`} onMouseDown={(e) => e.preventDefault()} onClick={() => choose(t)}>
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
  const { hits, loading } = useSearch(kind, query, open);
  const chosen = new Set(value.map((v) => v.id));

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", away);
    return () => window.removeEventListener("mousedown", away);
  }, [open]);

  const add = (h: ContainerHit) => {
    if (!chosen.has(h.id)) onChange([...value, { id: h.id, title: h.title, slug: h.slug, visibility: h.visibility }]);
    setQuery("");
    setActive(0);
  };
  const remaining = hits.filter((h) => !chosen.has(h.id));

  return (
    <div ref={box} className="relative space-y-2" data-testid={`${kind}-multi-picker`}>
      {value.map((v) => <input key={v.id} type="hidden" name={name} value={v.id} />)}
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Chosen ${WORD[kind].many}`}>
          {value.map((v) => (
            <li key={v.id} className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-alt px-2 py-0.5 text-sm">
              {/* A chip is also the way in: this is often the quickest route to the collection the item is in. */}
              {v.slug ? <a href={`/${kind === "trip" ? "trips" : "collections"}/${v.slug}`} className="text-primary hover:underline">{v.title}</a> : <span>{v.title}</span>}
              {visibilityNote(v.visibility) && <span className="text-xs text-muted">({visibilityNote(v.visibility)})</span>}
              <button type="button" aria-label={`Remove ${v.title}`} className="text-muted hover:text-foreground" onClick={() => onChange(value.filter((x) => x.id !== v.id))}>×</button>
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
        aria-activedescendant={open && remaining[active] ? `${listId}-${active}` : undefined}
        aria-label={`Add to a ${WORD[kind].one}`}
        className="h-8 w-full rounded border border-border bg-surface px-2 text-sm"
        placeholder={value.length ? `Add another ${WORD[kind].one}…` : `Search ${WORD[kind].many}…`}
        value={query}
        onFocus={() => { setOpen(true); setActive(0); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, remaining.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          else if (e.key === "Enter" && open && remaining[active]) { e.preventDefault(); add(remaining[active]); }
          else if (e.key === "Escape") { setOpen(false); setQuery(""); }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" className="absolute z-20 w-full max-h-64 overflow-y-auto rounded-theme border border-border bg-surface shadow-lg divide-y divide-border">
          <Results hits={hits} loading={loading} kind={kind} active={active} onPick={add} exclude={chosen} listId={listId} emptyNote={query ? undefined : `Every ${WORD[kind].one} is already chosen.`} />
        </ul>
      )}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
