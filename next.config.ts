import type { NextConfig } from "next";
import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots";

/**
 * Fetchers that read a page's HTML without running it, beyond the ones Next already knows. Everybody else gets the
 * og tags streamed into <body>, which these never read, so a public trip linked there would get no card: Mastodon,
 * Pleroma, Akkoma and Misskey servers (each builds its own preview), Iframely and Embedly (the embed services behind
 * many chat and publishing tools), Bluesky's card fetcher, Matrix's Synapse, Pinterest, curl and Wget; and Googlebot,
 * which Next leaves to stream because it runs scripts, but which need not depend on that.
 */
const extraHtmlLimitedBots = ["Mastodon", "Pleroma", "Akkoma", "Misskey", "Iframely", "Embedly", "Cardyb", "Synapse", "Pinterest", "Googlebot", "curl/", "Wget/"];

const nextConfig: NextConfig = {
  output: "standalone",
  // Setting this replaces Next's own list, so that list is extended here rather than restated. Next keeps only the
  // pattern's source and matches it case-insensitively.
  htmlLimitedBots: new RegExp([HTML_LIMITED_BOT_UA_RE.source, ...extraHtmlLimitedBots].join("|"), "i"),
  serverExternalPackages: ["sharp", "pg-boss", "fit-file-parser", "heic-convert", "stream-json", "exifr"],
  // The Favorites pages were briefly at the British spelling; a link somebody already sent keeps working.
  async redirects() {
    return [
      { source: "/favourites", destination: "/favorites", permanent: true },
      { source: "/trips/:slug/favourites", destination: "/trips/:slug/favorites", permanent: true },
      { source: "/collections/:slug/favourites", destination: "/collections/:slug/favorites", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Cross-origin requests (tiles, YouTube, link previews) get only our origin, never a path that could carry a share token.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Every response is taken as the type it says it is, so an uploaded file can never be sniffed into HTML.
          // (HSTS depends on APP_URL, which is only known when the server starts, so src/proxy.ts sends it.)
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
      {
        // Everything but member-uploaded media (below). Next applies these before a route runs, and a route cannot
        // replace a header already set here, so the two policies must be split by path rather than overridden.
        source: "/((?!api/photos/).*)",
        headers: [
          // Frame-related directives only for everything the proxy does not cover (API routes, static files);
          // pages get the full nonce-based policy from src/proxy.ts. Browsers enforce the intersection of both.
          { key: "Content-Security-Policy", value: "frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
        ],
      },
      {
        // Member-uploaded bytes: should one ever be opened as a page of its own, it runs nothing and has no origin.
        source: "/api/photos/:path*",
        headers: [
          // Kept equal to MEDIA_CSP in src/lib/security/csp.ts (the media route sends it too; a unit test compares them).
          { key: "Content-Security-Policy", value: "default-src 'none'; style-src 'unsafe-inline'; sandbox; frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
