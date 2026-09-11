/* A tiny stand-in for the external services the app talks to, so end-to-end tests never leave the machine. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const poster = readFileSync(path.join(here, "../fixtures/photo-no-gps.jpg"));
const annotation = readFileSync(path.join(here, "../fixtures/annotation-response.json"), "utf8");
const batches = new Map();

/** A Messages API reply shaped like the real one, with the recorded structured record as its text block. */
function message(model, text = annotation) {
  return { id: `msg_${Date.now()}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, stop_details: null, usage: { input_tokens: 3200, output_tokens: 380, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } };
}

import { createHash } from "node:crypto";
function hash(s) {
  return createHash("sha256").update(s).digest("hex");
}
/** The file bytes inside a multipart body, so the same image hashes the same whatever the random boundary is. */
function filePart(body) {
  const start = body.indexOf("\r\n\r\n");
  const end = body.lastIndexOf("\r\n--");
  return start >= 0 && end > start ? body.slice(start + 4, end) : body;
}
/** A unit vector whose components come from a hash of the seed, so equal inputs give equal vectors. */
function seeded(seed, dim) {
  const out = [];
  let h = createHash("sha256").update(seed).digest();
  while (out.length < dim) {
    for (let i = 0; i + 4 <= h.length && out.length < dim; i += 4) out.push((h.readUInt32LE(i) / 0xffffffff) * 2 - 1);
    h = createHash("sha256").update(h).digest();
  }
  const norm = Math.sqrt(out.reduce((a, v) => a + v * v, 0));
  return out.map((v) => v / norm);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function startMocks(port = 3201) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    // --- ML sidecar stand-in: deterministic unit vectors derived from the input, like the Python stub ---
    if (url.pathname === "/health") return json(200, { ok: true, models: "stub", dims: { image: 512, text: 384, face: 512 } });
    if (url.pathname.startsWith("/embed/") || url.pathname === "/faces") {
      if (req.headers["x-ml-token"] !== "e2e-ml-token") return json(401, { detail: "missing or wrong token" });
      const body = await readBody(req);
      if (url.pathname === "/embed/text") {
        const texts = JSON.parse(body || "{}").texts ?? [];
        return json(200, { embeddings: texts.map((t) => seeded(`text:${String(t).trim().toLowerCase()}`, 384)), dim: 384 });
      }
      if (url.pathname === "/embed/image") return json(200, { embedding: seeded(`image:${hash(filePart(body))}`, 512), dim: 512 });
      return json(200, { faces: [{ box: [0.3, 0.2, 0.25, 0.35], confidence: 0.98, embedding: seeded(`face:${hash(filePart(body))}`, 512), age: 34 }], dim: 512 });
    }
    // --- Anthropic Messages API stand-in ---
    if (url.pathname === "/v1/messages" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const text = JSON.stringify(body.messages ?? []);
      // An item whose notes ask for it exercises the refusal path.
      if (text.includes("REFUSE-ME")) return json(200, { ...message(body.model, ""), stop_reason: "refusal", stop_details: { type: "refusal", category: "other", explanation: "mock" } });
      const estimate = text.includes("Please estimate a year range") ? { ...JSON.parse(annotation), estimatedYear: { from: 1990, to: 1994, confidence: 0.55, evidence: "print border and the notes" } } : null;
      return json(200, message(body.model, estimate ? JSON.stringify(estimate) : annotation));
    }
    if (url.pathname === "/v1/messages/batches" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const id = `msgbatch_${Date.now()}`;
      batches.set(id, body.requests ?? []);
      return json(200, { id, type: "message_batch", processing_status: "in_progress", request_counts: { processing: body.requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 }, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), ended_at: null, cancel_initiated_at: null, results_url: null, archived_at: null });
    }
    const batchMatch = /^\/v1\/messages\/batches\/([^/]+)(\/results|\/cancel)?$/.exec(url.pathname);
    if (batchMatch) {
      const [, id, tail] = batchMatch;
      const requests = batches.get(id);
      if (!requests) return json(404, { type: "error", error: { type: "not_found_error", message: "no such batch" } });
      if (tail === "/cancel") return json(200, { id, type: "message_batch", processing_status: "canceling", request_counts: { processing: 0, succeeded: 0, errored: 0, canceled: requests.length, expired: 0 } });
      if (tail === "/results") {
        res.writeHead(200, { "content-type": "application/x-jsonl" });
        res.end(requests.map((r) => JSON.stringify({ custom_id: r.custom_id, result: { type: "succeeded", message: message(r.params.model) } })).join("\n") + "\n");
        return;
      }
      return json(200, { id, type: "message_batch", processing_status: "ended", request_counts: { processing: 0, succeeded: requests.length, errored: 0, canceled: 0, expired: 0 }, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(), ended_at: new Date().toISOString(), cancel_initiated_at: null, results_url: `http://127.0.0.1:${port}/v1/messages/batches/${id}/results`, archived_at: null });
    }
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
