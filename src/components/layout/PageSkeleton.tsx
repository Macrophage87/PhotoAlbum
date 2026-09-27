/** The grey placeholder a list page shows while its data loads on a client-side navigation. */
export function PageSkeleton() {
  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 py-10 animate-pulse space-y-6">
      <div className="h-9 w-40 bg-surface-alt rounded" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="aspect-[4/3] bg-surface-alt rounded-theme" />
        ))}
      </div>
    </div>
  );
}

/** The same inside a trip, collection or shared page's own layout, which already gives the width and padding. */
export function SectionSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="h-8 w-48 bg-surface-alt rounded" />
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-2">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="aspect-square bg-surface-alt rounded-theme" />
        ))}
      </div>
    </div>
  );
}
