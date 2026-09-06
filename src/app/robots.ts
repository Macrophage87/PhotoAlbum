import type { MetadataRoute } from "next";

/** Public trips may be indexed; everything that needs a session or a secret link may not. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: ["/", "/trips/"], disallow: ["/share/", "/auth/", "/admin", "/upload", "/photos/", "/api/", "/invite/"] }],
  };
}
