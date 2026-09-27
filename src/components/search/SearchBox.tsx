/**
 * The navigation search form: a plain GET so it works without JavaScript. With `asInput` it is only the box, for
 * a page whose own form carries the words together with its filters (a form inside a form is invalid HTML).
 */
export function SearchBox({ initial = "", className = "", asInput = false }: { initial?: string; className?: string; asInput?: boolean }) {
  const input = (
    <input
      type="search"
      name="q"
      defaultValue={initial}
      placeholder="Search photos…"
      aria-label="Search photos"
      className="h-9 w-full rounded-theme border border-border bg-surface px-3 text-sm text-text placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-ring"
    />
  );
  if (asInput) return <div className={className}>{input}</div>;
  return (
    <form action="/search" method="get" role="search" className={className}>
      {input}
    </form>
  );
}
