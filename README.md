# Family Album

A self-hosted photo album for family trips. Photos are grouped into **trips** and **activities**, browsed on a **timeline** and a **map**, and each trip gets its own visual **theme** (lighthouse coast, Scottish highlands, Everglades swamp, desert canyon, alpine, or classic). GPS tracks from a watch, bike computer, or Google location history give hikes and rides a route and fitness stats, and can even place photos that have no GPS of their own.

## Features

- **Trips → activities → photos.** Photos land on the right trip by the date they were taken and on the right activity by time.
- **Upload from any device.** Drag-and-drop or pick files; JPEG, PNG, WebP, HEIC. Originals are kept, web-sized WebP renditions are generated.
- **Correct times, everywhere.** Camera times are resolved with the EXIF offset, the GPS position, or the trip's time zone. A one-click fix handles cameras left in the wrong zone.
- **Timeline** grouped by local day, with activities holding their photos, plus a global timeline across trips.
- **Map** with clustered photo markers and colour-coded tracks, per trip and across all trips.
- **Tracks and stats.** Import GPX, Garmin FIT, or Google Timeline exports. Activities get distance, moving time, elevation, pace/speed, heart rate, cadence, power and calories, with elevation/pace/HR/power charts linked to the map.
- **Photos placed from tracks.** A photo taken during a hike without GPS is positioned by interpolating along the track.
- **Themes** per trip: palette, fonts, illustrated header art, map marker and motif.
- **Collections.** Gather photos from any trip, or none, around a theme: a person, a place, a year, the dog. A photo can sit in any number of collections, with its own order, cover and theme.
- **Sharing.** Each trip and each collection is private, shared by secret link, or public. Public ones appear on the front page for anyone.
- **Short clips.** MP4, MOV or WebM clips up to 90 seconds (`MAX_CLIP_SECONDS`) are transcoded with ffmpeg to a web-playable 1080p H.264 MP4 with a poster; HDR phone footage is tone-mapped. Clips play muted on hover in grids and with controls in the lightbox. Longer files are refused in the browser before upload and again on the server.
- **Videos on YouTube.** Longer videos are uploaded to YouTube as unlisted and embedded: paste the link, the album keeps the title and poster and plays the video in place through the privacy-enhanced player only when someone presses play. A weekly check flags videos that were deleted or made private.
- **Review and notes.** After an upload, a review screen lets you add a note to one photo or a whole batch ("Grandma Jo's 80th at the lake house"), file items into trips and collections, and mark them reviewed; an Unreviewed queue shows what nobody has looked at.
- **AI descriptions (opt-in).** With `ANTHROPIC_API_KEY`, `ANNOTATION_ENABLED=true` and an admin's opt-in on the Admin page, each reviewed item is described by Claude (`ANNOTATION_MODEL`, default `claude-opus-5`): caption, description, tags, place, a search summary, and for undated scans an estimated year to confirm. Items, trips and collections can be opted out; a scoped backfill with a cost estimate and typed confirmation describes the existing library at half price through the Batches API.
- **Local ML sidecar (optional).** A small Python service on an internal Docker network computes image embeddings (OpenCLIP), text embeddings (MiniLM) and face templates (InsightFace) on the CPU; nothing about a photo leaves the server. With it on, search blends meaning with keywords, the review screen suggests trips and collections by date, place and similarity, and people can be recognised locally (see People below). The face model is InsightFace's `buffalo_l`, whose weights are released for non-commercial use; fine for a family album, not for a commercial service.
- **People (local, consent-first).** With the sidecar on and an admin's opt-in, faces are found and grouped on the server; a member names a group once and it becomes a person with a page of their photos over time. Recognising someone in new photos is a separate per-person decision only an admin can make, off by default, never for a minor without a parent's instruction; unnamed faces are purged after `FACE_UNNAMED_RETENTION_DAYS`; a person can be forgotten at any time. Once a person is recognised, new faces that look like them are shown as "Probably …?" proposals for a member to confirm or reject (a rejection counts against that person from then on); a person owns one face group per era, matched by age at capture from their birthday and the photo's real or estimated date, and childhood matches use a stricter threshold. Names in your upload notes ("Sam at age 4") propose people too. Names and face chips are members-only, and a name reaches the AI helper only when that person's recognition is on and they are an adult.
- **Similarity graph.** With the sidecar on, each item's eight nearest look-alikes are stored, and a members-only graph page draws items as thumbnails with links by similarity, for the whole library (admins, capped at 3,000) or one trip, collection or person; colour by trip, collection, person or uploader, slide the threshold, click to open. Only links between items you may see are ever returned. The photo page shows a small "similar photos" strip under the same rule.
- **Pets.** Records with species and lifespan (or a flock record like "the chickens"), tagged by hand from the lightbox or proposed from your notes, with pages and search like people. No animal recognition runs.
- **Search.** Captions, notes, AI descriptions and tags, confirmed people's names (members only), titles, trip and collection names, and for members uploader names, through Postgres full-text search with filters by trip, collection, uploader, person (members only), year and type. Anonymous visitors search only public content and only the column that carries no names.
- **Photo links.** Mark photos as the same scene, before/after, parts of a panorama, or related.
- **Family sign-in** by emailed magic link; an admin invites members. No passwords.
- **Installable.** Add it to a phone's home screen and it opens full-screen like an app, with its own icon.

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env: set ADMIN_EMAIL, SMTP_* if you want real emails, and a new POSTGRES_PASSWORD
docker compose up --build
```

Open <http://localhost:3000>, enter the admin email, and follow the sign-in link. If SMTP is not configured, the link is printed in the container log:

```bash
docker compose logs -f app | grep "auth/verify"
```

To load demo content (two trips, a hike with stats, sample photos, a collection, a short clip, a YouTube embed, two named people, a pet and AI-style descriptions):

```bash
docker compose exec app node_modules/.bin/tsx prisma/seed.ts
```

The seed needs no network access and no API key: the descriptions are copied from a recorded fixture and the face templates are fixture vectors, so they show what the features look like without any live service. Each live feature has two switches, an environment flag and an admin's opt-in on the Admin page: descriptions need `ANNOTATION_ENABLED=true` plus `ANTHROPIC_API_KEY` and the opt-in; faces need the ML sidecar (`ML_URL`, `ML_TOKEN`), `FACE_INDEXING_ENABLED=true` and the opt-in. Until both switches are on, nothing is sent anywhere and no face is scanned.

Photos live in the `photos` volume, the database in `pgdata`. Back those two up.

### Installing on a phone

The album is a progressive web app, so once it is reachable over HTTPS it can be installed without an app store:

- **iPhone / iPad (Safari):** open the site, tap the Share button, then **Add to Home Screen**.
- **Android (Chrome):** open the site, tap the menu (three dots), then **Install app** or **Add to Home screen**.
- **Desktop (Chrome / Edge):** click the install icon at the right end of the address bar.

It launches full-screen with the Family Album icon. Uploads and sign-in work exactly as in the browser; when the network is unavailable an offline notice is shown instead of a browser error.

### Security headers

Every page is served with a nonce-based Content-Security-Policy: scripts only from this site with a per-request nonce, inline styles allowed (themes set style attributes), images and data only from this site and the configured map hosts (`NEXT_PUBLIC_TILE_URL`, `NEXT_PUBLIC_MAP_STYLE_URL`, `NEXT_PUBLIC_MAP_GLYPHS_URL`), frames only for the privacy-enhanced YouTube host, and no framing of this site by anyone. If a new map provider's assets are blocked, set `CSP_REPORT_ONLY=true` to see the violations in the browser console without blocking, then fix the host variables and turn enforcement back on.

### Behind a reverse proxy

For a full walkthrough of a fresh server (Docker, deploy key, HTTPS with Caddy, backups, updates) see [docs/DEPLOY.md](docs/DEPLOY.md).

Set `APP_URL` to the public URL (used in emails and redirects) and raise the proxy's body size limit (e.g. `client_max_body_size 2g;` in nginx, `max_size 2GB` in Caddy) so large photos, 1 GB clips (`MAX_VIDEO_UPLOAD_BYTES`) and Google exports get through. `MAX_UPLOAD_BYTES`, `MAX_VIDEO_UPLOAD_BYTES` and `MAX_IMPORT_BYTES` cap sizes on the app side.

### Maps

The map uses OpenStreetMap raster tiles by default, which is fine for family use. For heavier use set `NEXT_PUBLIC_TILE_URL` to a tile provider template, or `NEXT_PUBLIC_MAP_STYLE_URL` to a full MapLibre style.

## Importing tracks

| Source | What to upload | Result |
|---|---|---|
| Garmin, Wahoo, Strava, Komoot, AllTrails… | `.gpx` or `.fit` file | An activity with route, stats and charts. Photos in its time window are attached. |
| Google Maps Timeline (on device) | Google Maps → profile → Your Timeline → ⋯ → Location and privacy settings → **Export Timeline data** → `Timeline.json` | One location trace per day of the trip. |
| Google Takeout (older) | `Records.json` or the monthly `Semantic Location History` files | Same as above. |

Only points inside the trip's dates are imported, so uploading a whole export is safe. Google traces show dashed on the map and do not create activities.

## Development

Requirements: Node 22, pnpm, PostgreSQL 16.

```bash
pnpm install
cp .env.example .env            # point DATABASE_URL at your Postgres
pnpm prisma migrate dev         # creates the schema
pnpm db:seed                    # optional demo data
pnpm dev                        # http://localhost:3000
```

`docker compose -f docker-compose.yml -f docker-compose.dev.yml up db mailpit` gives you a Postgres on `localhost:5432` and a Mailpit inbox on <http://localhost:8025> for sign-in emails.

### Tests

```bash
pnpm test                     # unit tests; migrates (and creates if needed) the <db>_test database first
pnpm build && pnpm test:e2e   # Playwright smoke tests; the server script migrates a <db>_e2e database
```

Both need `DATABASE_URL` in `.env` to point at a Postgres server where that role may create databases.

Fixtures under `tests/fixtures` are generated by `node scripts/make-fixtures.mjs`.

### Layout

```
src/app            routes (App Router)
src/components     UI
src/lib/auth       magic links, sessions, trip access rules
src/lib/images     EXIF, renditions, HEIC
src/lib/tracks     GPX / FIT / Google parsers, stats, simplification, storage encoding
src/lib/jobs       pg-boss queue and every background job (processing, imports, geotagging, transcoding, annotation, embeddings, faces, purges)
src/lib/annotation Claude request building, schema, pricing, apply
src/lib/people     consent rules, clustering, matching, text-to-name
src/lib/search     Postgres full-text plus semantic search
src/lib/graph      nearest-neighbour edges and the graph payload
src/lib/ml         client for the sidecar
src/lib/security   the Content-Security-Policy builder
src/themes         theme registry and per-theme art
ml                 the Python ML sidecar (FastAPI)
prisma             schema, migrations and the offline seed
```

Heavy jobs (transcoding, embeddings, face detection) take a lock so only one runs at a time. That lock lives in the worker process, so run exactly one worker: either the web process (`RUN_WORKER=true`, the default) or the separate worker container, never both.

Background work (photo processing, imports, geotagging) runs inside the web process by default. To move it to its own container, set `RUN_WORKER=false` in `.env` and start the optional worker service:

```bash
docker compose --profile worker up -d
```

Outside Docker the equivalent is `pnpm worker` next to `pnpm dev`/`pnpm start` with `RUN_WORKER=false`.

## Configuration

See `.env.example` for every variable. The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `APP_URL` | Public URL of the site |
| `ADMIN_EMAIL` | This address becomes an admin when it first signs in |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Outgoing email; leave `SMTP_HOST` empty to log links instead |
| `PHOTO_STORAGE_ROOT` | Where originals and renditions are stored |
| `MAX_UPLOAD_BYTES`, `MAX_IMPORT_BYTES` | Upload limits |
| `POSTGRES_PASSWORD` | Database password for the `db` container; change it from the default |
| `NEXT_PUBLIC_TILE_URL`, `NEXT_PUBLIC_MAP_STYLE_URL`, `NEXT_PUBLIC_MAP_GLYPHS_URL` | Map basemap. Compiled into the browser bundle, so rebuild the image after changing them |

## How the AI features work and what leaves the server

With annotation on (two gates: `ANNOTATION_ENABLED` plus an admin's opt-in on the Admin page, both shown on the Privacy page), each reviewed item is sent once to Anthropic's API: the 1600-pixel rendition or a few frames of a clip, the uploader's notes, caption and title, the date and camera, and the trip and collection titles. Never the original file or face data; names only for confirmed people under the consent rule. The response is stored on the item; the raw response is kept `ANNOTATION_RAW_RETENTION_DAYS` days (default 30) and deleted with the item. Prompts and responses are never written to logs. Face templates never leave the server either: detection needs `FACE_INDEXING_ENABLED` plus an admin's opt-in, templates live in the database, unnamed ones expire, and forgetting a person deletes theirs. The ML sidecar (`ml/`) runs on this server only, on an internal Docker network with no outbound access, holds embeddings in memory only and writes nothing to disk or logs. Items, trips and collections can be opted out and are then never sent, including by a backfill. When a member embeds a YouTube video the server fetches its title and poster once (oEmbed, no API key) and re-checks weekly that it still exists; a viewer's browser contacts YouTube only when they press play. Set `YOUTUBE_API_KEY` to also record durations. Otherwise nothing leaves the server except sign-in email (through your SMTP provider, or the log when `SMTP_HOST` is empty), map tile requests made by the browser to the configured tile host (which sees only this site's origin), and the Facebook share button, which does nothing until pressed. The members-only **Privacy** page in the app lists the same flows with each switch's current state, and every feature that adds an outbound flow will extend both this section and that page, naming what is sent, which variable switches it off, and what is retained for how long.

## Server size

Without the ML sidecar the stack runs comfortably in 2 GB of RAM. The sidecar needs about 2 GB to itself with all models loaded, so the full stack wants 4 GB with a swap file, or 8 GB without; `docs/DEPLOY.md` has the steps. On a smaller server leave `ML_URL` unset: collections, video, descriptions and keyword search all still work, and only faces, semantic search, similarity suggestions and the graph are hidden. Long galleries load 240 items at a time and the timeline pages by day, so a 3,000-photo trip paints its first screen in well under two seconds (see `scripts/seed-perf.ts` and `scripts/measure-perf.mjs`).

## Privacy notes

A shared link or a public trip exposes every photo, activity and location trace on that trip, which reveals where people were and when. Trips and collections are private by default, the settings page spells out what each level shows, and a shared link can be rotated at any time.

A photo's visibility is the union of its containers: it can be seen by anyone who may open its trip or any collection holding it. Putting a photo from a private trip into a public collection therefore publishes that photo, and making a trip private does not hide a photo that also sits in a public collection. The interface warns before either happens.

Link previews (Facebook, chat apps) fetch a shared page's cover image without cookies, so the cover image address on a secret-link page carries the share token; whichever service renders the preview receives that secret link. That is inherent to previewing secret URLs.
