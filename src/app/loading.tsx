export default function RootLoading() {
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
