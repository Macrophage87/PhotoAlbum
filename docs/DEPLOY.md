# Deploying Family Album on a remote server

This guide takes a fresh Linux server to a running, HTTPS-secured Family Album that your family can reach from anywhere. It assumes an Ubuntu 22.04 or 24.04 VPS (Hetzner, DigitalOcean, Linode, a home server with a public address, and so on), but any Debian-based host with Docker works the same way.

Rough time: 30 minutes. You will need:

- A server with at least 2 GB RAM for the basic stack, or 4 GB with a swap file (8 GB without) if you run the optional ML sidecar for faces and similarity; enough disk for your photos (originals are kept, so budget your library size plus about 15 percent). Clip transcoding runs one at a time in the background; a 90-second 1080p clip takes 2 to 5 minutes on a 2-vCPU server, 4K HDR footage 5 to 15 minutes.
- SSH access as root or a sudo user.
- A domain name you control, for example `album.example.com`.
- An SMTP account for sign-in emails (Gmail with an app password, Fastmail, Postmark, Mailgun, your ISP). Optional at first; links can be read from the log.
- Access to this GitHub repository. It is private, so the server needs a deploy key or a personal access token to clone it.

---

## 1. Point DNS at the server

Create an `A` record for your chosen hostname pointing at the server's public IPv4 address (and an `AAAA` record if it has IPv6). Do this first so the record has propagated by the time HTTPS certificates are requested in step 6.

## 2. Prepare the server

SSH in and bring the system up to date. Create a non-root user for running the app if you are logged in as root.

```bash
apt update && apt upgrade -y
adduser album
usermod -aG sudo album
# copy your SSH key to the new user
rsync --archive --chown=album:album ~/.ssh /home/album
```

Log out and back in as `album`. Enable a firewall that allows only SSH, HTTP and HTTPS:

```bash
sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Optional hardening: disable password SSH logins (`PasswordAuthentication no` in `/etc/ssh/sshd_config`, then `sudo systemctl restart ssh`) and install `unattended-upgrades`.

## 3. Install Docker

Use Docker's official repository so you get Compose v2:

```bash
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo usermod -aG docker $USER
```

Log out and back in so the `docker` group applies, then check:

```bash
docker --version
docker compose version
```

## 4. Get the code

The repository is private. The simplest server-side method is a read-only deploy key.

```bash
ssh-keygen -t ed25519 -C "album-server" -f ~/.ssh/photoalbum_deploy -N ""
cat ~/.ssh/photoalbum_deploy.pub
```

Add the printed public key in GitHub under the repository's Settings, Deploy keys, with write access left off. Then tell SSH to use it for GitHub and clone the `main` branch:

```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/photoalbum_deploy
  IdentitiesOnly yes
EOF

git clone --branch main git@github.com:Macrophage87/PhotoAlbum.git ~/photoalbum
cd ~/photoalbum
```

For a staging server, clone `--branch staging` instead. To use a personal access token rather than a key, clone with `https://<token>@github.com/Macrophage87/PhotoAlbum.git`.

## 5. Configure the app

Copy the example configuration and edit it:

```bash
cp .env.example .env
nano .env
```

Set at least these values:

| Variable | Set to |
|---|---|
| `APP_URL` | `https://album.example.com` (your real hostname, with https). This appears in every sign-in email. |
| `ADMIN_EMAIL` | Your own email address. Only this address can create the first admin account. |
| `POSTGRES_PASSWORD` | A long random password, for example the output of `openssl rand -base64 24`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Your mail provider's settings. Leave `SMTP_HOST` empty to print links to the log instead. |
| `APP_PORT` | Leave at `3000`. The reverse proxy in the next step talks to it locally. |

Gmail example: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER` your address, `SMTP_PASS` an App Password from your Google account security page, `SMTP_FROM` the same address.

Leave `DATABASE_URL` as it is. Inside Docker Compose the app is pointed at the database container automatically using the `POSTGRES_*` values.

To let an AI helper describe photos for search, set `ANTHROPIC_API_KEY` and `ANNOTATION_ENABLED=true`, then turn the opt-in on from the Admin page; nothing is sent until both are set. See the README's privacy section for exactly what is sent.

Keep `.env` private: it is ignored by git and should never be committed.

## 6. Put HTTPS in front with Caddy

Caddy obtains and renews Let's Encrypt certificates automatically. Install it from the official repository:

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudflare.com/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudflare.com/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Replace `/etc/caddy/Caddyfile` with:

```
album.example.com {
    reverse_proxy 127.0.0.1:3000
    request_body {
        max_size 2GB
    }
    encode gzip
}
```

The body limit matters: photos are accepted up to 100 MB, short video clips up to 1 GB (`MAX_VIDEO_UPLOAD_BYTES`), and Google Timeline exports can be much larger. Reload Caddy:

```bash
sudo systemctl reload caddy
```

If you prefer nginx, the equivalent needs `client_max_body_size 2g;`, `proxy_read_timeout 600s;` and the usual `proxy_set_header Host`, `X-Forwarded-Proto` and `X-Forwarded-For` lines pointing at `http://127.0.0.1:3000`, plus certbot for certificates.

### Keep the app off the public interface

By default Compose publishes port 3000 on all interfaces. Since Caddy is the only client, bind it to localhost. Create `docker-compose.override.yml` next to `docker-compose.yml`:

```yaml
services:
  app:
    ports: !override
      - "127.0.0.1:${APP_PORT:-3000}:3000"
```

Compose merges this file automatically. The firewall from step 2 blocks port 3000 from outside anyway, so this is a second layer.

## 7. Build and start

```bash
cd ~/photoalbum
docker compose up --build -d
docker compose logs -f app
```

The first build takes a few minutes. Wait for `[entrypoint] starting server` and `[worker] pg-boss handlers registered`, then press Ctrl-C to stop following the log. The container applies database migrations itself on every start.

Check the health endpoint through the proxy:

```bash
curl -s https://album.example.com/api/health
```

It should print `{"ok":true}`.

### Optional: the ML sidecar (faces, similarity, semantic search)

The sidecar runs local models on the CPU and needs about 2 GB of RAM to itself. Add a swap file first on a 4 GB server:

```bash
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

Then in `.env` set `ML_URL=http://ml:8000` and `ML_TOKEN` to a long random string, fetch the model weights once (about 1.5 GB, on the default network; the sidecar itself has no outbound access), and start the profile:

```bash
docker compose run --rm ml-init
docker compose --profile ml up -d --build
```

`docker compose exec app node -e "fetch('http://ml:8000/health').then(r=>r.json()).then(j=>console.log(j))"` should print `models: idle` or `loaded`. The app refuses to start if `ML_URL` is set without `ML_TOKEN`.

For faces, also set `FACE_INDEXING_ENABLED=true` in `.env` and press **Turn on face detection** on the Admin page; faces nobody names are deleted after `FACE_UNNAMED_RETENTION_DAYS` (default 180). Put `COMPOSE_PROFILES=ml` in `.env` (add `,worker` if you use the separate worker) so every later `docker compose up`, including `deploy/update.sh`, starts the sidecar too; otherwise pass `--profile ml` each time.

### Media, AI and ML variables

The basics (`APP_URL`, `ADMIN_EMAIL`, `SMTP_*`, `POSTGRES_*`, `APP_PORT`, `MAX_UPLOAD_BYTES`, `MAX_IMPORT_BYTES`, `RUN_WORKER`, `NEXT_PUBLIC_*`, `COMPOSE_PROFILES`) are described in `.env.example` and the setup PDF's configuration table; these are the ones added with the media features.

| Variable | Default | What it does |
| --- | --- | --- |
| `MAX_CLIP_SECONDS` | `90` | Longest clip accepted for upload; longer videos go on YouTube. |
| `MAX_VIDEO_UPLOAD_BYTES` | `1073741824` (1 GB) | Largest clip file accepted. |
| `YOUTUBE_API_KEY` | empty | Optional Data API key so embedded videos show their length. |
| `ANNOTATION_ENABLED` | `false` | Operator half of the AI-description switch; the admin opt-in is the other half. |
| `ANTHROPIC_API_KEY` | empty | Required for descriptions. |
| `ANTHROPIC_BASE_URL` | empty | Proxy or mock endpoint for the helper; leave empty. |
| `YOUTUBE_OEMBED_URL`, `YOUTUBE_THUMBNAIL_URL`, `YOUTUBE_DATA_API_URL` | empty | Test doubles for the YouTube endpoints; leave empty. |
| `ANNOTATION_MODEL` | `claude-opus-5` | Model for descriptions (`claude-sonnet-5` and `claude-haiku-4-5` cost less). |
| `ANNOTATION_QUIET_MINUTES` | `30` | Minutes without edits before an unreviewed item is sent. |
| `ANNOTATION_RAW_RETENTION_DAYS` | `30` | How long raw responses are kept. |
| `ML_URL`, `ML_TOKEN` | empty | Sidecar address and shared secret; both or neither. |
| `ML_IDLE_UNLOAD_SECONDS` | `300` | Sidecar unloads its models after this idle time. |
| `FACE_INDEXING_ENABLED` | `false` | Operator half of the face-detection switch. |
| `FACE_UNNAMED_RETENTION_DAYS` | `180` | Unnamed faces are deleted after this. |
| `PET_MATCHING_ENABLED` | `true` | Animal spotting through the sidecar; a tagged pet is proposed on later look-alikes. |
| `IMPORT_INBOX_DIR` | `/data/imports` | Folder the Takeout importer reads; the compose file mounts the `imports` volume there. Empty hides the section. |
| `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | empty | OAuth client for the Google Photos picker (see below). |
| `TOKEN_ENCRYPTION_KEY` | empty | 32 random bytes, base64; encrypts members' Google refresh tokens at rest. Required with the client id. |
| `GEOCODER_ENABLED` | `true` | Address lookup in "Set a place"; the typed words go to `GEOCODER_URL` from the server. |
| `GEOCODER_URL` | Nominatim's public search | A Nominatim-compatible endpoint; point it at your own for heavy use. |
| `CSP_REPORT_ONLY` | `false` | Report Content-Security-Policy violations instead of blocking. |

### Optional: Google Photos

**Pick a few (the picker button).** In Google Cloud create a project, enable the *Google Photos Picker API*, configure the OAuth consent screen (External, add the family's addresses as test users unless you publish it) and create an OAuth client of type *Web application* with `https://album.example.com/api/google/callback` as the authorised redirect URI. Put the client id and secret in `.env` together with a fresh key:

```bash
openssl rand -base64 32   # → TOKEN_ENCRYPTION_KEY
docker compose up -d
```

Each member then presses **Connect Google Photos** on the Upload page once. The server keeps one refresh token per member, encrypted with `TOKEN_ENCRYPTION_KEY`; nothing else from Google is stored, and Google never sees the album. If Google revokes the grant (a password change, six months of disuse on a test-mode consent screen), the button says so and the member connects again. To rotate the key, generate a new one, restart, and tell members to reconnect: old tokens fail to decrypt and are treated as disconnected, and *Disconnect* still removes them. Removing a member deletes their token and asks Google to forget the grant.

**Everything at once (Takeout).** Export from Google Takeout with only *Google Photos* selected, in zip parts of 2 GB or 4 GB. Copy each part into the inbox and import it from the Admin page, one at a time:

```bash
docker compose cp ~/Downloads/takeout-20260901T120000Z-001.zip app:/data/imports/
```

The import streams the archive (memory stays flat whatever its size), reads the `.supplemental-metadata.json` sidecars for the capture date, position and description, turns each Google album folder into a private collection, and queues every item through the normal processing pipeline. A photo already in the album (same bytes, or the same Google item) is not imported again; instead the sidecar fills in whatever that photo is still missing and it joins its album's collection. **Importing an export you have already imported is therefore safe, and is the way to repair photos uploaded from a phone:** Android removes GPS from photos handed to any app without the `ACCESS_MEDIA_LOCATION` permission, so phone uploads arrive with an empty GPS block, while Takeout keeps the position in the sidecar. Only gaps are filled: a position the camera recorded or a member set by hand, a date from EXIF, and any notes or caption the family wrote are never overwritten. The run report lists what was filled in. Each import's counts and any failures show on the Admin page. The zip is an unencrypted copy of your whole export: delete it from the inbox from the Admin page once its photos are in. Nothing contacts Google during a Takeout import.

`ml-init` also fetches the animal detector used for pet spotting (about 80 MB); after upgrading from a version without it, run `docker compose run --rm ml-init` again or the sidecar answers 503 for animals and the app skips spotting.

The heavy-work lock (transcoding, embeddings, faces, animals one at a time) is held inside the worker process, so run exactly one worker: the web container (default) or the `worker` profile, not both.

## 8. First sign-in

1. Open `https://album.example.com` in a browser.
2. Enter the address you set as `ADMIN_EMAIL` and submit.
3. Open the emailed link. If SMTP is not configured, read it from the log instead:

   ```bash
   docker compose logs app | grep "auth/verify"
   ```

4. You are now the admin. Go to **Admin** in the navigation to invite family members by email.

Optionally load the demo content (two trips, a hike with track and stats, sample photos, a collection, a short clip, a YouTube embed, two named people and a pet, with descriptions and face templates from offline fixtures):

```bash
docker compose exec app node_modules/.bin/tsx prisma/seed.ts
```

## 9. Backups

Two Docker volumes hold everything: `photoalbum_pgdata` (database) and `photoalbum_photos` (originals and renditions). Check the exact names with `docker volume ls`; the prefix is the folder name the stack was started from.

Create a backup script at `~/backup-album.sh`:

```bash
#!/bin/bash
set -e
DEST=/home/album/backups
mkdir -p "$DEST"
STAMP=$(date +%F)
cd /home/album/photoalbum
docker compose exec -T db pg_dump -U photoalbum photoalbum | gzip > "$DEST/db-$STAMP.sql.gz"
docker run --rm -v photoalbum_photos:/data:ro -v "$DEST":/backup alpine \
  tar czf "/backup/photos-$STAMP.tgz" -C /data .
# keep the last 14 days locally
find "$DEST" -type f -mtime +14 -delete
```

Make it executable and run it nightly:

```bash
chmod +x ~/backup-album.sh
(crontab -l 2>/dev/null; echo "30 3 * * * /home/album/backup-album.sh >> /home/album/backup.log 2>&1") | crontab -
```

Copy the `backups` folder off the server regularly (rclone to any cloud storage, or `rsync` to another machine). A backup on the same disk as the data does not protect against disk failure.

To restore on a new server: bring the stack up once so the volumes exist, stop it, extract the photo archive into the photos volume with the same `docker run ... alpine tar` pattern in reverse, and pipe the SQL dump into `docker compose exec -T db psql -U photoalbum photoalbum`.

## 10. Updating

```bash
cd ~/photoalbum
git pull
docker compose up --build -d
docker image prune -f
```

Migrations run automatically at start. Take a database dump first (step 9) before any upgrade. In-flight photo processing is given 45 seconds to finish before the old container stops. A description backfill that is still submitting is cut short by an upgrade: the Admin page says so under that run within about an hour. Wait until no row of that run still reads "in progress" (batches already sent keep processing at Anthropic for up to a day), then run the backfill again for the remaining items; the app refuses to start a new run while one is open, so nothing is sent twice.

Two things to know when upgrading an install from before the media-hub release: the database image changed from `postgres:16` to `pgvector/pgvector:pg16` (same data format; compose replaces the container and keeps the `pgdata` volume, and the first start creates the `vector` extension), and if you run the ML sidecar its profile must be part of every `up`. Put `COMPOSE_PROFILES=ml` (plus `worker` if used) in `.env` so `docker compose up --build -d` and `deploy/update.sh` include it, then run `docker compose run --rm ml-init` once to fetch the weights.

## 11. Optional: separate worker container

Photo processing, HEIC conversion and track imports run inside the web container by default. On a busy or small server you can move them to their own container so page loads stay responsive:

1. Set `RUN_WORKER=false` in `.env`.
2. Start the stack with the worker profile:

   ```bash
   docker compose --profile worker up -d
   ```

Use the same `--profile worker` flag on every later `up` command, or the worker will not start and uploads will wait forever.

## 12. Optional: map tiles

The map uses OpenStreetMap's public tile server, which is fine for family use. For heavier traffic, set `NEXT_PUBLIC_TILE_URL` (for example a MapTiler or Stadia Maps template with your key) in `.env`. These values are compiled into the browser bundle, so rebuild afterwards with `docker compose up --build -d`.

## 13. Staging alongside production

To run a staging copy on the same server, clone the `staging` branch into a second folder such as `~/photoalbum-staging`, give it its own `.env` with a different `APP_URL` (for example `staging.album.example.com`), a different `APP_PORT` (say `3100`), and add a second site block in the Caddyfile pointing at that port. Compose names the volumes after the folder, so the two installs keep separate databases and photos.

## Troubleshooting

| Symptom | What to check |
|---|---|
| Certificate error or Caddy cannot get a certificate | DNS must resolve to this server and ports 80 and 443 must be open. `sudo journalctl -u caddy -n 50` shows the reason. |
| Site loads but sign-in email never arrives | `docker compose logs app \| grep -i smtp`. Wrong port and `SMTP_SECURE` pairing (587 with false, 465 with true) is the usual cause. Uninvited addresses receive nothing by design. |
| Links in emails point to localhost | `APP_URL` is still the default. Fix it in `.env` and run `docker compose up -d`. |
| Upload fails part way through | Proxy body limit. Confirm the `max_size` block in the Caddyfile and reload Caddy. |
| Photo stays on the spinner | `docker compose logs app` shows the processing error. The photo page offers Re-process. HEIC files take a few seconds each. |
| `docker compose up` fails with a database error | `docker compose logs db`. If you changed `POSTGRES_PASSWORD` after the first start, the existing volume keeps the old password; either restore the old value or recreate the volume. |
| Disk is filling up | Photos live in the `photoalbum_photos` volume under `/var/lib/docker/volumes`. Move Docker's data root to a larger disk or attach block storage there. |
| Container shows unhealthy | `curl http://127.0.0.1:3000/api/health` on the server. A 503 means the database is unreachable. |

Useful commands:

```bash
docker compose ps                 # status of db, app (and worker)
docker compose logs -f app        # live application log
docker compose restart app        # restart the web app only
docker compose down               # stop everything, keep data
docker system df                  # disk used by images and volumes
```

## Continuous deployment

Two GitHub Actions workflows in `.github/workflows/` deploy on push, the
same way the other sites on the family server do: **push to `staging`**
and the staging instance updates itself; **push to `main`** and the live
instance does. Each is one job with one SSH step that runs the shared
[`deploy/update.sh`](../deploy/update.sh) on the server with three
variables (`APP_DIR`, `BRANCH`, `APP_PORT`). The script dumps the database
to a `backups/` folder next to the checkout, resets the checkout to the
branch (`.env` and `docker-compose.override.yml` are untracked and
survive), runs `docker compose up --build -d`, waits for `/api/health`,
and prunes old images. A deploy rebuilds the image, so expect a short
outage of a minute or two per push; in-flight photo processing gets 45
seconds to finish first.

| Branch | Workflow | Checkout | Port |
|---|---|---|---|
| `staging` | `deploy-staging.yml` | `/cieply/sites/cieply.com/PhotoAlbum` | 3005 (dev.cieply.com) |
| `main` | `deploy-production.yml` | `/cieply/sites/cieply.com/PhotoAlbum-live` | 3004 (cieply.com) |

Until the three secrets below exist, or until the instance's folder exists
on the server, a workflow prints a note and exits green. `ci.yml` still
runs the test suite on every push as a visible ✓/✗ but does not gate the
deploy; `staging` itself is the gate for `main`.

To arm it (a private repo needs two keys: one for the runner to reach the
server, one for the server to read GitHub):

1. **Runner → server.** On the server, `ssh-keygen -t ed25519 -f
   photoalbum-actions -N ''`, append the `.pub` half to the deploy user's
   `~/.ssh/authorized_keys` (a user with passwordless sudo: the script
   runs git as the checkout's owner and docker via sudo), then add the
   repository secrets `DEPLOY_HOST` (the server's hostname, no `https://`),
   `DEPLOY_USER` and `DEPLOY_SSH_KEY` (the private half). Delete the
   private key file afterwards.
2. **Server → GitHub.** The checkout's owner needs a key that can read the
   repo: a read-only deploy key in their `~/.ssh` (step 4 above) or a
   personal key that already has access.
3. Push a commit to `staging` and watch the run under the repo's
   **Actions** tab; **Run workflow** there redeploys without a commit.

The production workflow points at a second checkout,
`PhotoAlbum-live`, with its own `.env` (`APP_PORT=3004`, `APP_URL`
`https://cieply.com`) and its own data directory — see step 13. It skips
until that folder exists.

## Security headers

Pages are served with a nonce-based Content-Security-Policy generated per request (see `src/proxy.ts`), so a reverse proxy must pass the `Content-Security-Policy` response header through unchanged and must not add its own. If you use a map tile or style provider, set `NEXT_PUBLIC_TILE_URL`, `NEXT_PUBLIC_MAP_STYLE_URL` and `NEXT_PUBLIC_MAP_GLYPHS_URL` before building the image: the policy allows exactly those hosts. `CSP_REPORT_ONLY=true` switches to reporting while you check a new provider.
