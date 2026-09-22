# Moving the album from `dev.cieply.com` to `cieply.com`

The album the family actually uses has been living at **dev.cieply.com**, on the
`staging` branch. It is being promoted: **cieply.com** becomes the real site on
`main`, and a *new, empty* **dev.cieply.com** is stood up beside it for work in
progress.

The deployment layout this ends at is the one `DEPLOY.md` already describes:

| Host | Branch | Checkout | Port | Holds |
|---|---|---|---|---|
| `cieply.com` | `main` | `/cieply/sites/cieply.com/PhotoAlbum-live` | 3004 | the family's photographs |
| `dev.cieply.com` | `staging` | `/cieply/sites/cieply.com/PhotoAlbum` | 3005 | test data only |

> **The one thing that must not go wrong.** The photographs and the database are
> in the *existing* instance — the one serving dev.cieply.com today. Starting a
> fresh `PhotoAlbum-live` checkout gives you an empty album at cieply.com and
> leaves every photograph behind. Either **promote the existing instance** (move
> its data into the live checkout, below) or accept that cieply.com starts empty.
> Decide this before touching DNS.

---

## 0. Before anything

- [ ] **Back up.** On the server, in the current checkout:
      ```bash
      docker compose exec -T db pg_dump -U photoalbum photoalbum | gzip > ~/album-before-move.sql.gz
      docker run --rm -v photoalbum_photos:/data:ro -v ~:/backup alpine \
        tar czf /backup/album-photos-before-move.tgz -C /data .
      ```
      Copy both off the server before continuing.
- [ ] **Lower the DNS TTL** on `cieply.com` and `dev.cieply.com` to 300 s, at
      least an hour before the cutover, so a mistake is five minutes to undo.
- [ ] **Decide the apex.** `cieply.com` needs an `A` (and `AAAA`) record; it
      cannot be a `CNAME` at the apex. Decide whether `www.cieply.com` redirects
      to the apex, and add that record too.
- [ ] **Check nothing else owns the apex.** If `cieply.com` already serves
      anything — another site, a parked page, email-only DNS — settle that
      first. Adding `A` records does not disturb `MX`, `SPF` or `DKIM`.

---

## 1. Move the data into the live checkout

Skip only if cieply.com is meant to start empty.

```bash
# On the server, as the deploy user
cd /cieply/sites/cieply.com
git clone -b main <repo-url> PhotoAlbum-live
cd PhotoAlbum-live
cp ../PhotoAlbum/.env .env          # then edit it — see step 2
cp ../PhotoAlbum/docker-compose.override.yml . 2>/dev/null || true
```

Then move the data across. Compose names volumes after the folder, so
`PhotoAlbum-live` gets its own `photoalbum-live_pgdata` and
`photoalbum-live_photos`; they start empty and must be filled from the backup
you just took:

```bash
cd /cieply/sites/cieply.com/PhotoAlbum && docker compose stop app      # no writes during the copy
cd ../PhotoAlbum-live && docker compose up -d db && sleep 10
gunzip -c ~/album-before-move.sql.gz | docker compose exec -T db psql -U photoalbum photoalbum
docker run --rm -v photoalbum-live_photos:/data \
  -v ~:/backup alpine tar xzf /backup/album-photos-before-move.tgz -C /data
```

`docs/MOVE-MEDIA.md` covers the media side in full, including the rule about two
installs sharing one media folder — **do not** point both instances at the same
photos unless they also share the database.

---

## 2. `.env` on each instance

In `PhotoAlbum-live/.env`:

```ini
APP_URL=https://cieply.com
APP_PORT=3004
```

In `PhotoAlbum/.env` (the new dev instance):

```ini
APP_URL=https://dev.cieply.com
APP_PORT=3005
```

`APP_URL` is read at runtime, so no rebuild is needed for it — but the process
caches it, so the container must be recreated (`docker compose up -d`), not just
reloaded. `NEXT_PUBLIC_*` values are different: they are compiled into the
browser bundle and need `docker compose up --build -d`.

**What `APP_URL` decides**, all of which break quietly if it is left at the old
host:

- every sign-in and invite link in email;
- every share link shown with a Copy button, and the Facebook share URL;
- `og:image` / `og:url` on public trips and collections (the preview card);
- the redirect after sign-in, sign-out and verification;
- the Google Photos OAuth redirect URI (`<APP_URL>/api/google/callback`);
- the identification sent with address lookups to Nominatim;
- on the Admin page's visitor statistics, which arrivals count as "from another
  site" — a stale `APP_URL` files your own pages under *Arrived from*.

---

## 3. Reverse proxy

Caddy, both sites, with the old host redirecting rather than serving:

```caddy
cieply.com {
    reverse_proxy 127.0.0.1:3004
    request_body { max_size 2GB }
    encode gzip
}

dev.cieply.com {
    reverse_proxy 127.0.0.1:3005
    request_body { max_size 2GB }
    encode gzip
}
```

If instead you want the old address to keep working for people who bookmarked
it, give the redirect its own hostname and put the new dev instance somewhere
else — you cannot both redirect `dev.cieply.com` and serve the dev instance from
it:

```caddy
old.cieply.com {
    redir https://cieply.com{uri} permanent
}
```

`{uri}` matters: it carries the path **and query string**, which is what keeps
`/share/<token>`, `/invite/<token>` and `/auth/verify?token=…` working from
links already sent.

On nginx the equivalent needs `client_max_body_size 2g;`,
`proxy_read_timeout 600s;` and `proxy_set_header Host`, `X-Forwarded-Proto`,
`X-Forwarded-For`.

- [ ] **Confirm `X-Forwarded-For` reaches the app.** Without it every visitor is
      counted as the same unknown browser on the Admin page's statistics, and
      rate limiting elsewhere sees one caller.
- [ ] **Do not let the proxy add a `Content-Security-Policy` header.** The app
      generates one per request with a nonce; a second one from the proxy breaks
      the page.

---

## 4. Things outside this repo that must be changed

- [ ] **Google Cloud → OAuth client → Authorized redirect URIs.** Add
      `https://cieply.com/api/google/callback`. Until it is there, "Import from
      Google Photos" fails with `redirect_uri_mismatch`. Add the dev one too if
      dev is meant to have the picker; keep the old URI until nobody is on it.
- [ ] **Email authentication for the new domain.** If mail is sent as
      `something@cieply.com`, the new domain needs its own SPF, DKIM and DMARC
      records, or sign-in links land in spam — which looks exactly like the app
      being broken. Check `SMTP_FROM` matches a domain you are allowed to send
      as.
- [ ] **GitHub Actions deploy secrets.** `deploy-production.yml` points at
      `PhotoAlbum-live` / port 3004 and `deploy-staging.yml` at `PhotoAlbum` /
      3005. They skip silently until those folders exist, so confirm the first
      run after the move actually deployed rather than skipped.
- [ ] **Facebook's link cache.** Previews of cieply.com may have been fetched
      while the site was elsewhere. Re-scrape each shared URL in Facebook's
      Sharing Debugger once the new host is live.
- [ ] **Uptime checks, bookmarks, the home screen icon.** Anyone who added the
      album to a phone's home screen has the old origin saved; they should add it
      again. The service worker is per-origin, so the old one keeps answering on
      the old host until it is unregistered or the host stops resolving.

---

## 5. What the family will notice

- **Everyone is signed out.** Session cookies are host-only, with no `domain`
  attribute, so nothing carries from `dev.cieply.com` to `cieply.com`. Each
  member requests one new sign-in link. Warn them, or the move looks like a
  fault.
- **Secret links still work, but the cookie is new.** `/share/<token>` sets its
  cookie per origin; the first visit on the new host re-sets it silently. The
  token itself is unchanged, so links already sent keep working *provided* the
  old host redirects with the path intact.
- **Anything a member had half-typed is gone**, as with any restart.
- **Visitor statistics carry over** with the data, and during the redirect period
  the old host appears under *Arrived from* — a useful measure of who is still
  on old links.

---

## 6. Verify, in this order

```bash
# DNS and certificates
dig +short cieply.com
curl -sSI https://cieply.com | head -n 1
curl -sS https://cieply.com/api/health

# The old host redirects, keeping the path and query
curl -sSI "https://old.cieply.com/share/abc?x=1" | grep -i location

# The app knows its own name: this must show cieply.com, not dev.
curl -sS https://cieply.com/trips/<a-public-trip> | grep -o '<meta property="og:url"[^>]*>'
```

Then, in a browser:

- [ ] Sign in with a fresh link and confirm the link in the email says
      `cieply.com`.
- [ ] Open a share link from an old message and confirm it lands on the trip.
- [ ] Upload a photograph larger than 10 MB and confirm it processes (proxy body
      limit and worker are both exercised).
- [ ] Open **Admin → Who has been looking** and confirm today's visits are being
      counted and that browsers are being told apart (if every visit shows as one
      browser, `X-Forwarded-For` is not reaching the app).
- [ ] Open **Admin** and confirm the Google Photos button connects.
- [ ] Confirm dev.cieply.com serves the *new, empty* instance and not the
      family's photographs.

---

## 7. Rollback

Nothing is destroyed by the move, which is what makes it safe:

1. Point the Caddy site block for the old host back at port 3005 and reload.
2. Put `APP_URL` back in the old instance's `.env`, `docker compose up -d`.
3. DNS reverts within the TTL you lowered in step 0.

The live checkout and its volumes can sit untouched until you try again.

---

## Appendix: a prompt for doing this with an agent

Paste this into a Claude Code session **on the server** (it needs shell access
there; it cannot be done from a checkout on another machine):

```text
You are helping move a self-hosted family photo album between hostnames on this
server. Read docs/DOMAIN-MOVE.md and docs/DEPLOY.md in this repository first and
follow them; they describe this exact deployment.

Where things stand:
- The instance holding the family's real photographs is the checkout at
  /cieply/sites/cieply.com/PhotoAlbum, on the `staging` branch, port 3005,
  currently served at dev.cieply.com.
- We want cieply.com to be the real site, on `main`, at
  /cieply/sites/cieply.com/PhotoAlbum-live on port 3004, WITH THE EXISTING
  DATA — database and photo volume both.
- We then want a fresh, empty instance on `staging` at port 3005 for
  dev.cieply.com.

Do this:
1. Confirm the current state before changing anything: which checkouts exist,
   which branch each is on, which containers are running, which volumes hold
   data and how large they are, and what the reverse proxy currently serves.
   Report it back to me and stop if it does not match the description above.
2. Take a database dump and a photo-volume archive from the existing instance,
   verify both are non-empty, and tell me their sizes and where they are.
3. Create the PhotoAlbum-live checkout on `main`, give it its own .env with
   APP_URL=https://cieply.com and APP_PORT=3004, and restore the dump and the
   photos into its volumes. Verify by counting rows in "Photo" and files under
   the photo volume and comparing with the source.
4. Reset the existing checkout to a clean `staging` instance for dev.cieply.com
   with APP_URL=https://dev.cieply.com and APP_PORT=3005. Ask me before deleting
   or reusing any volume that still holds the only copy of anything.
5. Update the reverse proxy for both hostnames, confirm X-Forwarded-For and
   X-Forwarded-Proto are passed through, and confirm the proxy adds no
   Content-Security-Policy header of its own.
6. Run the verification list in section 6 of docs/DOMAIN-MOVE.md and report each
   result. Anything you cannot check from the server — the Google Cloud redirect
   URI, SPF/DKIM/DMARC for cieply.com, Facebook's link cache — list for me to do
   by hand.

Rules:
- Never delete a database, a volume or a checkout without showing me the command
  and getting a yes. Restoring into an empty volume is fine; overwriting one
  that holds data is not.
- Stop and ask if the data does not appear where you expect it. An empty album
  at cieply.com is the failure mode we are trying to avoid.
- Report what you actually observed, with the commands and their output, not
  what you expect the steps to have done.
```
