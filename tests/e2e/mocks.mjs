/* A tiny stand-in for the external services the app talks to, so end-to-end tests never leave the machine. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const poster = readFileSync(path.join(here, "../fixtures/photo-no-gps.jpg"));

export function startMocks(port = 3201) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    if (url.pathname === "/oembed") {
      const target = url.searchParams.get("url") ?? "";
      const id = /v=([A-Za-z0-9_-]{11})/.exec(target)?.[1];
      if (!id || id === "gonegonegon") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ title: `Mock video ${id}`, author_name: "Mock Channel", thumbnail_url: `http://localhost:${port}/vi/${id}/hqdefault.jpg` }));
      return;
    }
    if (url.pathname.startsWith("/vi/")) {
      if (url.pathname.endsWith("maxresdefault.jpg")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(poster);
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1");
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startMocks();
