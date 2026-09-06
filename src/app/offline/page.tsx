import Link from "next/link";

export const metadata = { title: "Offline" };

/** Shown by the service worker when a page cannot be fetched. */
export default function OfflinePage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-6 text-center">
      <div className="max-w-sm space-y-3">
        <h1 className="font-display text-2xl font-semibold">You are offline</h1>
        <p className="text-muted">Family Album needs a connection to load photos and trips. Reconnect and try again.</p>
        <Link href="/" className="inline-block mt-2 px-4 py-2 rounded-theme bg-primary text-primary-fg">
          Retry
        </Link>
      </div>
    </main>
  );
}
