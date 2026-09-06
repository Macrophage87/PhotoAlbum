import type { MetadataRoute } from "next";

/** Web app manifest: lets phones and desktops install the album as an app (Add to Home Screen). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Family Album",
    short_name: "Album",
    description: "Our trips, photos, and adventures.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#f8fafc",
    theme_color: "#1f3a5f",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
