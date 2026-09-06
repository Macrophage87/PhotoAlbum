import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["sharp", "pg-boss", "fit-file-parser", "heic-convert", "stream-json", "exifr"],
};

export default nextConfig;
