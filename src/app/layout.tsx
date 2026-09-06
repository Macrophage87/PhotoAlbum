import type { Metadata } from "next";
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
import "./globals.css";

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
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${fontVars} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
