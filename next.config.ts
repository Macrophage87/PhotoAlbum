import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["sharp", "pg-boss", "fit-file-parser", "heic-convert", "stream-json", "exifr"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Cross-origin requests (tiles, YouTube, link previews) get only our origin, never a path that could carry a share token.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Frame-related directives only for everything the proxy does not cover (API routes, static files);
          // pages get the full nonce-based policy from src/proxy.ts. Browsers enforce the intersection of both.
          { key: "Content-Security-Policy", value: "frame-src https://www.youtube-nocookie.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
