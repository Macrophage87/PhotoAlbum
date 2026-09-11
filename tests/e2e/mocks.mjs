/* A tiny stand-in for the external services the app talks to, so end-to-end tests never leave the machine. */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const poster = readFileSync(path.join(here, "../fixtures/photo-no-gps.jpg"));
const annotation = readFileSync(path.join(here, "../fixtures/annotation-response.json"), "utf8");
const batches = new Map();
const pickerSessions = new Map();
const fixtureBytes = (name) => readFileSync(path.join(here, "../fixtures", name));

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
    if (url.pathname.startsWith("/embed/") || url.pathname === "/faces" || url.pathname === "/animals") {
      if (req.headers["x-ml-token"] !== "e2e-ml-token") return json(401, { detail: "missing or wrong token" });
      const body = await readBody(req);
      if (url.pathname === "/embed/text") {
        const texts = JSON.parse(body || "{}").texts ?? [];
        return json(200, { embeddings: texts.map((t) => seeded(`text:${String(t).trim().toLowerCase()}`, 384)), dim: 384 });
      }
      if (url.pathname === "/embed/image") return json(200, { embedding: seeded(`image:${hash(filePart(body))}`, 512), dim: 512 });
      if (url.pathname === "/animals") return json(200, { animals: [{ box: [0.1, 0.5, 0.4, 0.4], species: "DOG", confidence: 0.9, embedding: seeded(`animal:${hash(filePart(body))}`, 512) }], dim: 512 });
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
    // --- Google OAuth and the Photos Picker API stand-ins ---
    if (url.pathname === "/google-accounts/o/oauth2/v2/auth") {
      // The consent screen: send the browser straight back with a code, keeping the state.
      const back = new URL(url.searchParams.get("redirect_uri"));
      back.searchParams.set("code", url.searchParams.get("prompt") === "consent" && url.searchParams.get("access_type") === "offline" ? "mock-code" : "no-offline");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      back.searchParams.set("scope", url.searchParams.get("scope") ?? "");
      res.writeHead(302, { location: back.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/google-oauth/token" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      if (form.get("client_id") !== "e2e-client" || form.get("client_secret") !== "e2e-secret") return json(401, { error: "invalid_client" });
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "mock-code") return json(400, { error: "invalid_grant", error_description: "bad code" });
        return json(200, { access_token: "mock-access", refresh_token: "mock-refresh", expires_in: 3600, scope: "https://www.googleapis.com/auth/photospicker.mediaitems.readonly", token_type: "Bearer" });
      }
      if (form.get("refresh_token") === "mock-refresh") return json(200, { access_token: "mock-access", expires_in: 3600, token_type: "Bearer" });
      return json(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
    }
    if (url.pathname === "/google-oauth/revoke") return json(200, {});
    if (url.pathname.startsWith("/google-picker/")) {
      const rest = url.pathname.slice("/google-picker/".length);
      // The picking page a person would see: visiting it counts as picking two fixture photos and one clip and pressing Done.
      if (rest.startsWith("pick/")) {
        const s = pickerSessions.get(rest.slice(5));
        if (s) s.mediaItemsSet = true;
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body><h1>Mock Google Photos picker</h1><p>Done. You can close this tab.</p></body></html>");
        return;
      }
      if (rest.startsWith("download/")) {
        const [name, mode] = rest.slice(9).split("=");
        if (req.headers.authorization !== "Bearer mock-access") return json(401, { error: "unauthenticated" });
        res.writeHead(200, { "content-type": mode === "dv" ? "video/mp4" : "image/jpeg" });
        res.end(fixtureBytes(name));
        return;
      }
      if (req.headers.authorization !== "Bearer mock-access") return json(401, { error: { code: 401, status: "UNAUTHENTICATED" } });
      if (rest === "sessions" && req.method === "POST") {
        const id = `sess-${pickerSessions.size + 1}-${Date.now()}`;
        const s = { id, pickerUri: `http://127.0.0.1:${port}/google-picker/pick/${id}`, mediaItemsSet: false, pollingConfig: { pollInterval: "1s", timeoutIn: "1800s" }, expireTime: new Date(Date.now() + 1800_000).toISOString() };
        pickerSessions.set(id, s);
        return json(200, s);
      }
      if (rest.startsWith("sessions/")) {
        const s = pickerSessions.get(rest.slice(9));
        if (!s) return json(404, { error: { code: 404 } });
        if (req.method === "DELETE") { pickerSessions.delete(s.id); return json(200, {}); }
        return json(200, s);
      }
      if (rest.startsWith("mediaItems")) {
        const s = pickerSessions.get(url.searchParams.get("sessionId") ?? "");
        if (!s?.mediaItemsSet) return json(400, { error: { code: 400, message: "not set" } });
        const base = `http://127.0.0.1:${port}/google-picker/download/`;
        return json(200, { mediaItems: [
          { id: "gp-item-1", createTime: "2025-08-12T13:30:00Z", type: "PHOTO", mediaFile: { baseUrl: `${base}photo-with-gps.jpg`, mimeType: "image/jpeg", filename: "photo-with-gps.jpg", mediaFileMetadata: { width: 1200, height: 800 } } },
          { id: "gp-item-2", createTime: "2019-07-03T12:00:00Z", type: "PHOTO", mediaFile: { baseUrl: `${base}photo-no-exif.jpg`, mimeType: "image/jpeg", filename: "IMG_2001.jpg", mediaFileMetadata: { width: 800, height: 600 } } },
          { id: "gp-item-3", createTime: "2019-07-04T12:00:00Z", type: "VIDEO", mediaFile: { baseUrl: `${base}clip.mp4`, mimeType: "video/mp4", filename: "clip.mp4", mediaFileMetadata: { width: 320, height: 240 } } },
        ] });
      }
      return json(404, { error: { code: 404 } });
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
