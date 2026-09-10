# Next phase: media hub, collections, AI annotation

This document has two parts. Part A is a feasibility assessment of the requested features against the current codebase. Part B is the implementation prompt to hand to a future session. Nothing here has been implemented.

---

## Part A. Feasibility assessment

### What exists today (baseline)

Family Album at `main`/`staging`: Next.js 16, Prisma 7 on Postgres 16, pg-boss background jobs, local photo storage, magic-link auth with ADMIN/MEMBER roles, trips with activities and GPS tracks, per-trip themes, per-trip visibility (PRIVATE, LINK, PUBLIC), photo linking, installable PWA. Every photo already records `uploaderId`, so "track which family member uploaded which photo" is already stored; it only needs to be surfaced in the interface.

### Feature-by-feature

| Requested feature | Verdict | Notes |
|---|---|---|
| Collections alongside trips, both shareable | **Straightforward** | New `Collection` and `CollectionItem` tables (many-to-many). Reuse the trip visibility model and share-cookie mechanism by generalising `canViewTrip` into a `canView(entity)` helper. A photo stays on at most one trip but can sit in any number of collections. |
| Video upload and playback | **Moderate** | Store the original, transcode in a background job with ffmpeg to H.264 MP4 (1080p max) plus a poster frame and thumbnail. Adds ffmpeg (about 300 MB) to the Docker image and CPU time (roughly real-time on a small VPS). Uploads over 100 MB need a chunked, resumable upload path; a single request is too fragile on phones. Phone HEVC/HDR video needs a tone-mapping step or it plays washed out. |
| "Flash videos" | **Needs a definition** | Assumed to mean short clips (under a minute or so) that play inline and autoplay muted in grids, like stories or reels. If it means something else, say so in the prompt's open questions. |
| Text context at upload, used for AI annotation | **Straightforward** | A review step after upload where the uploader adds free text (batch-apply to many files). A job sends the medium rendition plus the text plus known metadata to Claude with a structured-output schema and stores a description, tags, place, activity, objects, visible text, mood and a searchable summary. |
| Searchable pictures | **Straightforward** | Postgres full-text search over caption, annotation, tags, people and place names covers keyword search. Adding pgvector with text embeddings of the annotation gives "photos of us eating lobster on a boat" style semantic search. |
| Learn to identify specific family members | **Feasible, with one important constraint** | Claude will not identify real people from their faces; that is prohibited by Anthropic's usage policy, and the model declines. Identification must be done locally with a self-hosted face-embedding model. The workable design: detect faces and compute embeddings on the server, cluster them, let the family name a cluster once, then auto-match new faces by similarity with a confirm/reject step. The uploader's text ("Grandma Jo at the lake") lets the app propose that an unnamed face is Grandma Jo. Names, once confirmed by the family, are passed to Claude as text so descriptions can mention them. Claude never does the recognising. |
| Suggest matching trips and collections on upload | **Straightforward** | A scoring function combining date-range fit, GPS proximity to a trip's photos and tracks, people overlap, tag overlap with a collection's title and description, and embedding similarity to the collection's centroid. Show the top three with one-click attach. |
| Track uploader | **Already stored** | Show "uploaded by" on cards and detail pages, add a filter, and a per-member count on the admin page. |
| Network graph of similar images | **Moderate** | Needs image embeddings (a CLIP-style model). Precompute the nearest neighbours per photo into an edge table, then render with a WebGL graph library. Comfortable up to several thousand nodes; beyond that, show the graph for a trip, collection or person rather than the whole library. |
| Photos in several collections, attach after upload | **Straightforward** | Follows from the many-to-many model; bulk actions already exist in the gallery and extend naturally. |

### Architectural additions this implies

1. **An ML sidecar container.** Face embeddings and image embeddings are best run as a small Python service (FastAPI with InsightFace and OpenCLIP, CPU only) in a new `ml` compose service. This keeps the Node image lean and uses mature models. Cost: about 2 GB image, roughly one second per image on a modest CPU, which is fine for a family library processed in the background. A pure-Node alternative exists (ONNX models through `@huggingface/transformers` and `@vladmandic/face-api`) and avoids a second language at the price of weaker face models.
2. **pgvector.** Swap the database image to `pgvector/pgvector:pg16` and add `vector` columns for face, image and text embeddings. Prisma handles them as `Unsupported("vector(N)")` with raw SQL for nearest-neighbour queries.
3. **ffmpeg** in the app image and a `transcode-video` job.
4. **Claude API** for annotation, with an `ANTHROPIC_API_KEY` secret and a per-install switch.

### Cost of AI annotation (order of magnitude)

Per image sent at the 1600-pixel medium rendition: roughly 2,500 input tokens for the image, about 1,000 tokens of cacheable instructions, and about 400 output tokens.

| Model | Approx. cost per image | 10,000 photos | Notes |
|---|---|---|---|
| `claude-opus-5` | about $0.03 | about $300 | Best descriptions and judgement. Default per Anthropic guidance. |
| `claude-sonnet-5` | about $0.01 | about $100 | Very good for this task. |
| `claude-haiku-4-5` | about $0.005 | about $50 | Adequate for tags and short captions. |

The Message Batches API halves these prices for backlog annotation, and prompt caching makes the instruction block nearly free after the first call. The model is a configuration setting so the choice stays with the owner; the prompt below defaults to Opus 5 and exposes the setting.

### Things to decide before starting (the prompt lists them as open questions)

- The meaning of "flash videos".
- Whether sending photos to Anthropic's API for annotation is acceptable for this family, and whether individual uploads can opt out.
- Consent for face indexing: a per-person opt-out, and whether children's faces are indexed at all.
- Whether a Python sidecar is acceptable, or the ML must stay in Node.
- Server size: CPU-only inference is fine for a few thousand photos; a 100,000-photo library wants a bigger box or a GPU.

Overall: everything requested is buildable on the current codebase. The two pieces that change the shape of the system are video (ffmpeg plus resumable uploads) and the ML sidecar with pgvector; the rest is schema and interface work. A realistic sequence is five phases, each shippable on its own, described in the prompt.

---

## Part B. Implementation prompt

Copy everything below this line into a new session on the `Macrophage87/PhotoAlbum` repository.

---

You are extending **Family Album**, a self-hosted family photo application in this repository. Read `README.md`, `AGENTS.md`, `docs/DEPLOY.md`, `prisma/schema.prisma`, `src/lib/jobs/`, `src/lib/auth/access.ts`, `src/app/api/upload/route.ts` and `src/components/photos/Uploader.tsx` before writing code. The stack is Next.js 16 (App Router; note `src/proxy.ts`, not middleware), React 19, Prisma 7 with the pg adapter, PostgreSQL, pg-boss for background jobs, sharp and exifr for images, Vitest and Playwright for tests, Docker Compose for deployment. Follow the existing conventions: server components for reads, server actions with zod validation and an auth check as the first statement, route handlers for streaming uploads, `loadViewableTrip`-style helpers that enforce visibility in every page, and jobs that are idempotent and leave a `FAILED` state with a message rather than hanging.

Work on a branch named `claude/media-hub`, commit after each phase with a clear message, push after each phase, and never push to `main` or `staging`. Run `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:e2e` before each push and keep them green. Add unit tests for every new library module and extend the Playwright suite with at least one flow per phase. Update `README.md`, `.env.example`, `docs/DEPLOY.md` and `scripts/make-setup-pdf.py` whenever behaviour, configuration or the compose stack changes, and regenerate `docs/SETUP.pdf`.

### Goal

Turn the app from a trip album into the family's media hub. The centre of the admin side becomes **ingestion**: every family photo and video gets uploaded here, enriched with context, made searchable, and filed into trips and collections. The centre of the family side becomes **sharing**: trips and collections are both first-class, shareable things.

### Product requirements

1. **Collections.** A collection is a named, described, themed set of media (photos and videos) that is independent of trips. A media item belongs to at most one trip but any number of collections. Collections have the same visibility levels as trips (PRIVATE, LINK, PUBLIC) with share links that can be rotated, a cover, and the same theme picker. Collections appear on the front page next to trips, in the global timeline and map, and have their own read-only share pages. Members can create collections, add and remove items singly or in bulk from any gallery, and reorder items by drag or by date.

2. **Video.** Accept video uploads (MP4, MOV, HEVC from phones, WebM). Keep the original, transcode in a background job to a web-playable H.264 MP4 capped at 1080p with a poster frame and a thumbnail, record duration and dimensions, and tone-map HDR sources. Videos appear in galleries, timelines, maps and lightboxes with inline playback. Short clips (see the assumption below) autoplay muted in grids on hover or tap and loop. Uploads larger than a configurable threshold use a chunked, resumable protocol so a phone on poor Wi-Fi can finish a multi-gigabyte upload after interruptions; smaller files keep the current single-request path.

3. **Ingestion with context.** After files are uploaded and processed, the uploader lands on a **review** screen for that batch. There they can type free-text context for one item or for a selection ("Grandma Jo's 80th at the lake house, everyone came"), see the AI annotation draft, accept suggested trips and collections, and name detected faces. Context can also be added or edited later from the item page. Items that have never been reviewed are listed in an "Unreviewed" queue for admins.

4. **AI annotation.** A background job sends each new item (medium rendition for photos; poster frame plus two or three evenly spaced frames for videos) to Claude together with the uploader's text, EXIF facts (date, place from reverse geocoding when available, camera), the trip or collection it is attached to, and the names of any people the family has confirmed in it. Claude returns a structured record: a one-line caption, a longer description, tags, place, activity, objects, visible text, season and mood, and a search summary. Store it on the item, keep the raw response for debugging, and mark the annotation as machine-generated until a member edits it. Provide a "re-annotate" action and a bulk backfill for the existing library that uses the Message Batches API. Annotation is on by default but can be disabled per install with an environment variable and per upload with a checkbox. Never send an item Claude has already annotated unless the context changed.

5. **Search.** A search box in the navigation that searches captions, descriptions, tags, people, places, trip and collection names, and uploader. Keyword search uses Postgres full-text search with a stored `tsvector` and ranking. Semantic search uses a text embedding of the annotation summary in pgvector, blended with the keyword score. Results show media cards with the matching snippet and can be filtered by trip, collection, person, uploader, year and media type. Search respects visibility: anonymous visitors only see PUBLIC content.

6. **People.** Detect faces and compute face embeddings for every photo and video poster frame on the server, locally, using the ML sidecar described below. Cluster embeddings into unnamed people. Members name a cluster once (creating a `Person` record with name, optional relationship and birthday), after which new faces are matched by cosine similarity above a threshold and shown as "probably Sam" until confirmed or rejected; rejected matches are remembered as negative examples. The uploader's text is used to propose names: when the text mentions one known person and the photo has one unmatched face, propose that pairing. Confirmed names are passed to the annotation job as text and become searchable. Each person has a page with their media over time. Provide an opt-out per person that deletes their embeddings and stops future matching, and a global switch for face indexing. Do not attempt to identify people with Claude; it is not permitted and the model will decline.

7. **Suggestions on upload.** For each new item compute a ranked list of candidate trips and collections and show the top three on the review screen with one-click attach. Signals: the item's date inside a trip's date range; GPS within a small distance of the trip's tracks or photos; people overlap with a collection's existing items; tag and text overlap with a collection's title and description; image-embedding similarity to the collection's centroid. Show why each suggestion was made ("same week, 2 km from the Ocean Path hike").

8. **Uploader attribution.** Show "uploaded by" on media cards and detail pages, add an uploader filter to galleries and search, and a per-member upload count on the admin page. This is already stored as `uploaderId`; surface it.

9. **Similarity graph.** Compute a CLIP-style image embedding per item, precompute the nearest neighbours into an edge table, and provide a graph page (whole library for admins, plus scoped graphs for a trip, collection or person) that renders nodes as thumbnails and edges by similarity using a WebGL graph library. Colour nodes by trip, collection, person or uploader; clicking a node opens the lightbox; a slider sets the similarity threshold. Cap the whole-library graph at a few thousand nodes and offer the scoped views beyond that.

### Assumptions (change these if wrong)

- "Flash videos" means short clips of roughly a minute or less that play inline and autoplay muted in grids. Longer videos play in the lightbox with controls.
- Sending media to Anthropic's API is acceptable for this family; the per-install switch and per-upload opt-out exist for those who disagree.
- A Python ML sidecar is acceptable in the compose stack; CPU-only inference is fine for the expected library size.
- Face indexing is on by default for adults and off for anyone flagged as a child on their Person record.

### Architecture decisions

- **Schema.** Rename nothing; extend `Photo` into a media table by adding `kind` (PHOTO, VIDEO), `durationS`, `videoRenditions` JSON, `context` text, `annotation` JSON, `annotationModel`, `annotatedAt`, `annotationSource` (MACHINE, EDITED), `reviewedAt`, `searchVector tsvector` (maintained by a trigger), and `embedding vector(512)`. Add `Collection` (slug, title, description, themeKey, visibility, shareToken, coverId, createdById), `CollectionItem` (collectionId, mediaId, position, addedById, unique pair), `Person` (name, relationship, birthday, isChild, faceIndexing boolean, createdById), `Face` (mediaId, personId nullable, box, embedding vector(512), confidence, status DETECTED/PROPOSED/CONFIRMED/REJECTED, proposedPersonId), `MediaSimilarity` (mediaAId, mediaBId, score, unique pair with A < B), `UploadSession` (for chunked uploads: id, uploaderId, filename, size, mimeType, receivedBytes, storageKey, expiresAt). Keep `PhotoLink` for manual links.
- **Visibility.** Generalise `canViewTrip` into `canView(viewer, { kind: "trip" | "collection", ... })` and the share cookie into `share_<kind>_<id>`. Every page and API route for collections uses it. Media that belongs to no trip or collection is members-only.
- **Database image.** Switch compose to `pgvector/pgvector:pg16`; add the `vector` extension in a migration. Nearest-neighbour queries are raw SQL through Prisma with an HNSW index.
- **ML sidecar.** New `ml/` directory with a FastAPI service (Python 3.12, CPU builds of onnxruntime, InsightFace `buffalo_l` for faces, OpenCLIP ViT-B/32 for image embeddings, a small sentence-embedding model for text) exposing `POST /faces`, `POST /embed/image`, `POST /embed/text`, `GET /health`. Add it as the `ml` compose service on an internal network only, with model weights cached in a named volume and downloaded on first start. The Node side talks to it over HTTP with a typed client and treats it as optional: if `ML_URL` is unset, face and embedding features are hidden and the rest of the app works.
- **Video.** Install ffmpeg in the app image. New `transcode-video` job with concurrency 1. Probe with ffprobe, transcode with libx264 at CRF 22 and AAC audio, scale to fit 1920x1080, apply tone mapping for HDR (bt2020 to bt709), extract a poster at 10 percent of duration and a thumbnail, and write `videoRenditions`. Serve through the existing `/api/photos/[id]/[size]` route with range requests for playback.
- **Uploads.** Keep the current streaming route for files under `CHUNKED_UPLOAD_THRESHOLD_BYTES` (default 64 MB). Above it, the client creates an `UploadSession`, sends fixed-size chunks with an offset, and finishes with a complete call; the server appends chunks to a temporary file, verifies the size, moves it into place and enqueues processing. Sessions expire after a day and are cleaned up by a job.
- **Annotation job.** Use the official `@anthropic-ai/sdk` with `client.messages.parse` and a zod schema for structured output. Default model `claude-opus-5`, configurable with `ANNOTATION_MODEL`. Put the fixed instructions in a cached system block and keep per-item content after it. Use adaptive thinking at low effort; this is a description task. Handle `stop_reason` of `refusal` by recording the refusal and moving on. For the backfill, submit through the Message Batches API and poll for results. Never include face embeddings or ask the model to identify anyone; pass confirmed names as text only.
- **Search.** A `search_vector` column with a trigger over caption, description, tags, people, place, trip and collection titles. Text embeddings for the semantic half come from the sidecar. Blend scores 70/30 keyword/semantic, tuned by a test set of a few dozen queries against the seed data.
- **Suggestions.** A pure function in `src/lib/suggest/` scoring candidates from the signals above, with unit tests, called after processing and again when context is edited.
- **Graph.** After embedding, upsert the eight nearest neighbours above 0.75 cosine into `MediaSimilarity`. Render with Sigma.js and Graphology on a client-only page; supply nodes and edges from a JSON route that applies visibility.

### Phases

Each phase is shippable and ends with a commit, a push, green checks, and documentation updates.

**Phase 1. Collections and attribution.** Schema for collections, `canView` generalisation, collection pages (overview, items, timeline, map, settings, share pages), create and edit forms, bulk add-to-collection from galleries and search, front-page cards, uploader shown everywhere, uploader filter and admin counts. Playwright: create a collection, add photos from two trips, share it by link, view it anonymously.

**Phase 2. Video and resumable uploads.** ffmpeg in the image, `transcode-video` job, video cards and lightbox playback, short-clip autoplay, chunked uploads with an `UploadSession`, range-request serving, cleanup job. Playwright: upload a small fixture MP4, see the poster in the gallery, play it.

**Phase 3. Ingestion review and AI annotation.** Review screen, context on items, annotation job with structured output, annotation display and editing on the item page, re-annotate and backfill actions, per-install and per-upload switches, keyword search box and results page with filters. Unit tests use a recorded fixture of the model response so tests run without an API key. Playwright: upload with context, see the annotation appear (mock the model in test mode), search for a tag.

**Phase 4. ML sidecar, people and suggestions.** `ml` service, pgvector migration, face detection and clustering, People pages with naming, proposing and confirming, opt-out, image and text embeddings, semantic search blend, suggestion scoring on the review screen. Unit tests for clustering, matching thresholds and the suggestion scorer; the sidecar has its own pytest smoke test. Playwright: name a face, see the suggestion appear on the next upload (with a stub sidecar in test mode).

**Phase 5. Similarity graph and polish.** Neighbour computation, graph page with scoping and filters, per-person and per-collection graphs, performance pass on galleries with thousands of items (virtualised grids, cursor pagination), and a final documentation pass including a "How the AI features work and what leaves the server" section in the README.

### Non-goals for this phase

Comments and reactions, native mobile apps, S3 storage, editing photos, shared albums with external accounts, automatic album generation.

### Definition of done

All five phases merged into `claude/media-hub`, CI green, the seed script extended with a collection, a short video, two named people and annotations so a fresh install demonstrates every feature, and the setup guide updated for the new services and secrets.

### Open questions for the owner

1. Confirm the meaning of "flash videos".
2. Confirm that media may be sent to Anthropic's API for annotation, and which model to default to given the cost table in the planning document.
3. Confirm the face-indexing consent rules, including children.
4. Confirm a Python sidecar is acceptable, or ask for a Node-only variant.
5. Expected library size, to size the server and decide whether the whole-library graph is worth building.
