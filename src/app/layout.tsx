import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { RegisterServiceWorker } from "@/components/pwa/RegisterServiceWorker";
import { VisitBeacon } from "@/components/visits/VisitBeacon";
import { UploadQueueProvider } from "@/components/photos/UploadQueue";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { env } from "@/lib/env";
import { getViewer } from "@/lib/auth/viewer";
import { wantsLargeText } from "@/lib/reading/large-text";

// One typeface for the whole album, in every theme: Atkinson Hyperlegible, drawn by the Braille Institute so that
// letters easily mistaken for each other are told apart. It is here for the older readers in the family. It comes in
// two weights, so the browser draws medium as regular and semibold as bold.
const atkinson = Atkinson_Hyperlegible({ variable: "--font-atkinson", subsets: ["latin"], weight: ["400", "700"], style: ["normal", "italic"] });

const fontVars = atkinson.variable;

export const metadata: Metadata = {
  title: { default: "Family Album", template: "%s · Family Album" },
  description: "Our trips, photos, and adventures.",
  applicationName: "Family Album",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  // iOS reads these for Add to Home Screen; Android uses the manifest.
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Family Album" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#1f3a5f",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page carries a per-request CSP nonce (set in src/proxy.ts), so nothing is prerendered at build time.
  await headers();
  // Larger text and stronger contrast, for whoever asked for it (globals.css, `.large-text`). A page that cannot
  // reach the database still draws, in the usual size.
  const largeText = await getViewer().then(wantsLargeText, () => false);
  return (
    <html lang="en" className={`${fontVars} h-full antialiased${largeText ? " large-text" : ""}`}>
      <body className="min-h-full flex flex-col">
        {/* The first thing a keyboard reaches: past the navigation to the page itself (every page's <main id="main">). */}
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-theme focus:bg-surface focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-text focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring">
          Skip to content
        </a>
        {/* Uploads carry on from page to page, so their queue lives above every page. Always mounted: a layout is not
            rendered again on navigation, so a tab opened before signing in must already have it. Until something is
            added it renders nothing and asks the server nothing. */}
        <UploadQueueProvider>{children}</UploadQueueProvider>
        <SiteFooter largeText={largeText} />
        <RegisterServiceWorker />
        {env().VISITOR_STATS_ENABLED && <VisitBeacon />}
      </body>
    </html>
  );
}
