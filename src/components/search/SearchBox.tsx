/** The navigation search form: a plain GET so it works without JavaScript. */
export function SearchBox({ initial = "", className = "" }: { initial?: string; className?: string }) {
  return (
    <form action="/search" method="get" role="search" className={className}>
      <input
        type="search"
        name="q"
        defaultValue={initial}
        placeholder="Search photos…"
        aria-label="Search photos"
        className="h-9 w-full rounded-theme border border-border bg-surface px-3 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </form>
  );
}
