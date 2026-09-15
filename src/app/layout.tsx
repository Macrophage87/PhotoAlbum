import type { Metadata, Viewport } from "next";
import {
  Inter,
  Playfair_Display,
  Source_Sans_3,
  Cormorant_Garamond,
  Lato,
  Fraunces,
  Nunito,
  Bitter,
  Work_Sans,
  Montserrat,
  Open_Sans,
} from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { RegisterServiceWorker } from "@/components/pwa/RegisterServiceWorker";
import { VisitBeacon } from "@/components/visits/VisitBeacon";
import { env } from "@/lib/env";

// Every theme's font pair is loaded once here and referenced by CSS variable.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const playfair = Playfair_Display({ variable: "--font-playfair", subsets: ["latin"] });
const sourceSans = Source_Sans_3({ variable: "--font-source-sans", subsets: ["latin"] });
const cormorant = Cormorant_Garamond({ variable: "--font-cormorant", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const lato = Lato({ variable: "--font-lato", subsets: ["latin"], weight: ["400", "700"] });
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"] });
const nunito = Nunito({ variable: "--font-nunito", subsets: ["latin"] });
const bitter = Bitter({ variable: "--font-bitter", subsets: ["latin"] });
const workSans = Work_Sans({ variable: "--font-work-sans", subsets: ["latin"] });
const montserrat = Montserrat({ variable: "--font-montserrat", subsets: ["latin"] });
const openSans = Open_Sans({ variable: "--font-open-sans", subsets: ["latin"] });

const fontVars = [inter, playfair, sourceSans, cormorant, lato, fraunces, nunito, bitter, workSans, montserrat, openSans]
  .map((f) => f.variable)
  .join(" ");

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
  return (
    <html lang="en" className={`${fontVars} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <RegisterServiceWorker />
        {env().VISITOR_STATS_ENABLED && <VisitBeacon />}
      </body>
    </html>
  );
}
