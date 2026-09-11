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
        ],
      },
    ];
  },
};

export default nextConfig;
