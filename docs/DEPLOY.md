# Deploying Family Album on a remote server

This guide takes a fresh Linux server to a running, HTTPS-secured Family Album that your family can reach from anywhere. It assumes an Ubuntu 22.04 or 24.04 VPS (Hetzner, DigitalOcean, Linode, a home server with a public address, and so on), but any Debian-based host with Docker works the same way.

Rough time: 30 minutes. You will need:

- A server with at least 2 GB RAM for the basic stack, or 4 GB with a swap file (8 GB without) if you run the optional ML sidecar for faces and similarity; enough disk for your photos (originals are kept, so budget your library size plus about 15 percent, and on top of that about the size of the original again for every photo that visitors open at full size: a public or shared photo opened full size gets a copy with its location and camera details taken out, made once in the background, one at a time and within about 450 MB of memory, and kept beside the original. Nothing expires these copies yet; deleting a photo deletes its copy, and a copy of a picture since edited or moved is replaced the next time a visitor opens it). Clip transcoding runs one at a time in the background; a 90-second 1080p clip takes 2 to 5 minutes on a 2-vCPU server, 4K HDR footage 5 to 15 minutes.
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
| `APP_URL` | `https://album.example.com` (your real hostname, with https). This appears in every sign-in email. With https the app also sends HSTS, so browsers keep to https for a year. |
| `HSTS_INCLUDE_SUBDOMAINS` | Leave at `false`. Set `true` only if every subdomain of the album's hostname serves https, to extend HSTS to them. |
| `ADMIN_EMAIL` | Your own email address. Only this address can create the first admin account, and only while there is no admin: once one exists it is an ordinary address, so removing that account from the Admin page sticks. |
| `SIGN_IN_MAIL_PER_HOUR` | Leave at `200`. Protects your mail provider's quota. Each address holds at most three unused sign-in links at a time; its first always goes out, and only the second and third count against this hourly total. Once it is used up, asking for another link while one is still live says to try again later, but anybody without a live link still gets one. |
| `POSTGRES_PASSWORD` | A long random password, for example the output of `openssl rand -base64 24`. |
| `FORGET_KEY` | The output of `openssl rand -base64 32`, a different one for each instance. Forgotten people's names are kept as hashes under it, and without it nobody can be forgotten for good. Back it up now, apart from the database backups of step 9 (they do not contain it), and never change it (see the variable table below). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Your mail provider's settings. Leave `SMTP_HOST` empty to print links to the log instead. |
| `APP_PORT` | Leave at `3000`. The reverse proxy in the next step talks to it locally. |
| `APP_BIND` | Leave at `127.0.0.1`, so the app is reachable only through that proxy (Docker's published ports bypass ufw). |

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

The body limit matters: photos are accepted up to 100 MB, short video clips and 3D scans up to 1 GB (`MAX_VIDEO_UPLOAD_BYTES`, `MAX_SCAN_UPLOAD_BYTES`), and Google Timeline exports can be much larger. Reload Caddy:

```bash
sudo systemctl reload caddy
```

If you prefer nginx, the equivalent needs `client_max_body_size 2g;`, `proxy_read_timeout 600s;` and the usual `proxy_set_header Host`, `X-Forwarded-Proto` and `X-Forwarded-For $proxy_add_x_forwarded_for` lines pointing at `http://127.0.0.1:3000` (the app trusts only the last `X-Forwarded-For` entry, the one your proxy adds), plus certbot for certificates.

### Keep the app off the public interface

Compose publishes the app's port on `127.0.0.1` only (`APP_BIND` in `.env`), so Caddy on the same host is the only way in. Keep it that way: Docker writes its own firewall rules for published ports, so **ufw from step 2 does not protect a port Docker publishes**; `APP_BIND=0.0.0.0` would put the app on the internet directly, past Caddy, its HTTPS and the `X-Forwarded-For` the app relies on for rate limiting. If an older `docker-compose.override.yml` of yours still sets the ports line, it can go.

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

For faces, also set `FACE_INDEXING_ENABLED=true` in `.env` and press **Turn on face detection** on the Admin page; faces nobody names are deleted after `FACE_UNNAMED_RETENTION_DAYS` (default 180). Face detection relies on the heavy-work lock (see section 11, "Optional: separate worker container"): it scans one photo at a time and groups each face against the groups as it last read them, so run a single worker process. Put `COMPOSE_PROFILES=ml` in `.env` (add `,worker` if you use the separate worker) so every later `docker compose up`, including `deploy/update.sh`, starts the sidecar too; otherwise pass `--profile ml` each time.

### Media, AI and ML variables

The basics (`APP_URL`, `ADMIN_EMAIL`, `SMTP_*`, `POSTGRES_*`, `APP_PORT`, `MAX_UPLOAD_BYTES`, `MAX_IMPORT_BYTES`, `RUN_WORKER`, `NEXT_PUBLIC_*`, `COMPOSE_PROFILES`) are described in `.env.example` and the setup PDF's configuration table; these are the ones added with the media features.

| Variable | Default | What it does |
| --- | --- | --- |
| `MAX_CLIP_SECONDS` | `90` | Longest clip accepted for upload; longer videos go on YouTube. |
| `MAX_VIDEO_UPLOAD_BYTES` | `1073741824` (1 GB) | Largest clip file accepted. |
| `MAX_SCAN_UPLOAD_BYTES` | `1073741824` (1 GB) | Largest 3D scan (GLB, USDZ, PLY, SPZ) accepted. |
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
| `FORGET_KEY` | empty | Exactly 32 random bytes, base64 — make it with `openssl rand -base64 32`; with a random salt kept in the database, it makes the key forgotten people's names are hashed under, so neither a database copy nor the secret alone is enough. In production nobody can be forgotten for good without it, and a value that is not 32 bytes of base64 counts as none (the server logs an error at start): "Forget face data" then switches the person off at once and finishes once a valid key is set. `deploy/update.sh` makes one in `.env` if there is none, and says so — unless the database already keeps names forgotten under a key, when it stops for that key to be put back — but an older checkout's first deploy of the release that brought it runs the older script, which makes none: see [Upgrading from before the forget key](#upgrading-from-before-the-forget-key). The script dumps only the database (to `$BACKUP_DIR`), so back `FORGET_KEY` up separately with the rest of `.env`, and never change it: once a name has been forgotten under it, running without it or with another pauses forgetting and the AI helper, in any environment, until it is put back. Names forgotten before it was set (under a key made from the database alone) are still recognized; the Admin page says how many. |
| `GEOCODER_ENABLED` | `true` | Address lookup in "Set a place"; the typed words go to `GEOCODER_URL` from the server. |
| `GEOCODER_URL` | Nominatim's public search | A Nominatim-compatible endpoint; point it at your own for heavy use. |
| `VISITOR_STATS_ENABLED` | `true` | Count pages opened, for the Admin page's "Who has been looking". Nothing leaves the server. |
| `VISITOR_STATS_RETENTION_DAYS` | `90` | Days those counts are kept before a nightly job deletes them with the day's hashing salt. |
| `CSP_REPORT_ONLY` | `false` | Report Content-Security-Policy violations instead of blocking. |

### Optional: Google Photos

**Pick a few (the picker button).** In Google Cloud create a project, enable the *Google Photos Picker API*, configure the OAuth consent screen (External, add the family's addresses as test users unless you publish it) and create an OAuth client of type *Web application* with `https://album.example.com/api/google/callback` as the authorized redirect URI. Put the client id and secret in `.env` together with a fresh key:

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

**Takeout inbox permissions.** The app runs as the `node` user and deletes archives from `/data/imports`, so that folder must be writable by it. The image creates it owned by `node`, and a new `imports` volume takes that over. A volume made by an older image belongs to `root`, and deleting an archive from the Admin page then says the inbox is not writable; give it to `node` once:

```bash
docker compose run --rm --user root --entrypoint chown app -R node:node /data/imports
```

`ml-init` also fetches the animal detector used for pet spotting (about 80 MB); after upgrading from a version without it, run `docker compose run --rm ml-init` again or the sidecar answers 503 for animals and the app skips spotting.

The heavy-work lock (transcoding, embeddings, faces, animals one at a time) is held inside the worker process, so run exactly one worker: the web container (default) or the `worker` profile, not both.

## 8. First sign-in

1. Open `https://album.example.com` in a browser.
2. Enter the address you set as `ADMIN_EMAIL` and submit.
3. Open the emailed link and press **Sign in**. If SMTP is not configured, read the link from the log instead:

   ```bash
   docker compose logs app | grep "auth/verify"
   ```

   If no email arrives, check the app's log (`docker compose logs app`): SMTP errors are logged there.

4. You are now the admin. Go to **Admin** in the navigation to invite family members by email.

Optionally load the demo content (two trips, a hike with track and stats, sample photos, a collection, a short clip, a YouTube embed, two named people and a pet, with descriptions and face templates from offline fixtures):

```bash
docker compose exec app node_modules/.bin/tsx prisma/seed.ts
```

### If the only admin can no longer read their email

`ADMIN_EMAIL` creates an admin only while the album has none, so once an admin exists, changing it does nothing. If the only admin loses their mailbox, fix it in the database from the server. Either move the admin account to a new address:

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c "UPDATE \"User\" SET email = '"'"'new@example.com'"'"' WHERE email = '"'"'old@example.com'"'"';"'
```

or make another member an admin:

```bash
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -c "UPDATE \"User\" SET role = '"'"'ADMIN'"'"' WHERE email = '"'"'cousin@example.com'"'"';"'
```

Addresses are stored in lower case. `UPDATE 1` means it worked; then sign in with that address as usual.

## 9. Backups

Two Docker volumes hold everything: `photoalbum_pgdata` (database) and `photoalbum_photos` (originals and renditions). Check the exact names with `docker volume ls`; the prefix is the folder name the stack was started from.

Create a backup script at `~/backup-album.sh`:

```bash
#!/bin/bash
# pipefail: without it a failed pg_dump still leaves a small, useless .gz and the script carries on.
set -eo pipefail
# The dumps hold every member's address and every name in the album: readable by this user only.
umask 077
DEST=/home/album/backups
mkdir -p "$DEST"
STAMP=$(date +%F)
cd /home/album/photoalbum
# The db container's own POSTGRES_USER and POSTGRES_DB, so this follows whatever .env sets.
docker compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$DEST/db-$STAMP.sql.gz.partial"
# pg_dump writes this line last; without it the dump stopped partway.
gzip -cd "$DEST/db-$STAMP.sql.gz.partial" | tail -n 20 | grep -c 'PostgreSQL database dump complete' >/dev/null
mv "$DEST/db-$STAMP.sql.gz.partial" "$DEST/db-$STAMP.sql.gz"
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

To restore on a new server, put the database back **before the album starts for the first time**. The first start migrates an empty database and gives it an install id of its own, which the dump's `AppSetting` row then collides with and loses. So create the volumes without starting the app, load the dump, then the photos, then start everything:

```bash
cd ~/photoalbum
docker compose create                    # the containers and volumes, nothing running
docker compose start db
gunzip -c db-YYYY-MM-DD.sql.gz | docker compose exec -T db sh -c 'exec psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker run --rm -v photoalbum_photos:/data -v /home/album/backups:/backup alpine \
  tar xzf /backup/photos-YYYY-MM-DD.tgz -C /data
docker compose up -d
```

The photo archive brings its `.album-install-id` with it and the dump brings the same id, but the database now lives in another Postgres, so the Admin page will say under **Storage** that the storage is bound to another database. Make sure the old album is stopped for good, and check this one looks right. The marker also carries the old album's last heartbeat, so **Re-bind the storage to this database** becomes available there 48 hours after the old album last ran (the page says when); until then the album works normally but cleans nothing up. If the album was started before the dump went in, stop it, empty the database (`docker compose exec -T db sh -c 'exec psql -U "$POSTGRES_USER" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" "$POSTGRES_DB"'`), load the dump, start it again, and re-bind.

If the photographs have been moved onto their own drive, the volume in that script is no longer what the album reads: see [MOVE-MEDIA.md](MOVE-MEDIA.md), which says what to change here.

**Restoring an older dump over the same photos** (rolling back a mistake): the album is still the same album, so its clean-ups keep running. Uploaded GPX and FIT files kept for tracks added after the dump (`imports/`) have no track in the restored database, and the hourly clean-up deletes them after six hours. Copy `imports/` somewhere safe before restoring if you might want those tracks again. Photo folders from after the dump are only counted, never deleted.

### The install marker

The media folder has a small file at its top, `.album-install-id`, that names the album (the same id as the database's `AppSetting.installId`) and the database it belongs to (the Postgres cluster's system identifier and the database name, kept as `AppSetting.installBinding`). A copy of the database, such as a staging clone, carries the id but is a different database, so it does not match. The worker of the database the folder belongs to also writes a heartbeat into the file when it starts and every hour.

The worker writes the file by itself only into an empty folder, on a new install. A folder that already holds photos or uploaded track files — every existing album, the first time it runs this version — shows **This storage has not been claimed by this album yet** under **Storage** on the Admin page, with a **Claim this storage** button, and nothing in it is cleaned up until an admin presses it. Press it on the live site, never on a staging site that shares the live folder: a staging copy of the live database knows every photo in it. A claim is refused:

- while another database's heartbeat in the file is less than 48 hours old;
- while files this database does not know (a photo folder with no photo here, or an uploaded track file nothing here refers to) have been written in the last 48 hours — "Files were added here … ago that this database doesn't know. Another album may still be using this storage (stop it first), or an upload failed here recently; …" That is live, still on older code, adding photos next to a staging clone — or, on a single album, a track upload that failed under the old code in the last two days, which older versions never cleaned up; wait until it is 48 hours old and claim again;
- unless the database has a photo for at least 95% of the photo folders (for an album with tracks but no photos at all, a track or an import in progress for 95% of the uploaded track files).

Uploaded track files that nothing refers to, such as failed imports kept by older versions, do not stop a photo album from being claimed once they are two days old; the hourly clean-up deletes them afterwards. A marker that is there is never replaced by the worker.

The album reads the cluster's system identifier with `pg_control_system()`. The database user the album connects as normally owns the database and may call it; if it may not, the Admin page says the album cannot check which database this is, nothing is cleaned up, and the fix is to run, as a superuser, `GRANT EXECUTE ON FUNCTION pg_control_system() TO <the album's user>;`.

Before the album cleans up anything in the media folder (track files left by an import that died, folders of items deleted for good) it checks that the file, the database's id and the database itself all agree. If they do not, it cleans up nothing, says so in the log, and shows a red notice under **Storage** on the Admin page. What to do depends on the notice:

- **"This storage holds files this album's database does not know."** The folder is another album's, or this database is missing much of it (the wrong database, or a restore that has not gone in yet). Connect the right database. Do not force it.
- **The storage is bound to another database.** There are two very different reasons:
  - *A staging copy of the live database pointed at the live folder.* Never re-bind it. Staging's database has live's photos, so it would pass every check, and then clean up live's new files as if they were nobody's. Give staging its own copy of the media ([MOVE-MEDIA.md](MOVE-MEDIA.md), option C).
  - *The album was moved or restored to another server.* Stop the old album for good. **Re-bind the storage to this database** on the Admin page becomes available once the old album's heartbeat in the file is 48 hours old, and until then the button is not offered and the action is refused ("Another database used this storage … ago; stop that album first, then wait until …"). It also refuses unless the database accounts for the folder by the same test as above. Then it writes this database's id, binding and heartbeat into both places.
- **This database has no install id** (restored from a dump taken before the marker existed): check the album looks right, then re-bind, with the same waits and checks.
- **The file is missing** (media copied without dot files, say): **Claim this storage**, with the same waits and checks. On a folder that is empty the worker writes it at its next start.
- **Another database used this folder … ago**, on the live site after a staging site claimed or re-bound a folder the two share: stop the staging site, give it its own copy of the media, and re-bind here once the page offers it (48 hours after the staging site's last heartbeat).
- **The heartbeat cannot be read** (the file was edited by hand): stop any other site that shares the folder, then remove the `heartbeatAt` and `heartbeatBinding` fields from the file, or put back a copy from a backup.
- **The file is another album's.** Two installs are using one media folder with different databases. Stop, and give each its own folder (or share the database too; see [MOVE-MEDIA.md](MOVE-MEDIA.md)). Do not edit the file to make the notice go away: the check is what keeps one album from deciding the other's photos are rubbish.

Never point two installs with different databases at one media folder, and that includes a staging copy of the live database. Each would see the other's photos as files nobody owns.

### The quarantine

Every hour the worker counts folders under `photos/` that no photo in the database refers to and that nothing has written to for a week, and the Admin page shows the number under **Storage**. Nothing is deleted by itself. An admin can type the number to move those folders into `quarantine/<date>/` in the media folder; the move is refused when the album has no photos, when the install marker does not match, or when it would take more than 200 folders or 5% of all of them at once, since that many usually means the database is the wrong one. Each day's folder keeps a `.moved.json` saying when each folder was moved in. A folder in the quarantine can be moved back into `photos/` by hand. **Empty quarantine older than 30 days** deletes what that record says was moved in over 30 days ago, and nothing newer or unrecorded; a folder whose photo is back in the database by then (after a restore) is put back in `photos/` instead of deleted, or left in the quarantine if its place there has been taken, and the page says which.

## 10. Updating

```bash
cd ~/photoalbum
git pull
docker compose up --build -d
docker image prune -f
```

**Check free disk space before every upgrade or deploy.** A deploy writes a full database dump next to the checkout, builds a new image (a few GB of build cache, pruned to one day's worth afterwards), and some migrations rewrite a whole table, which needs room for a second copy of it until Postgres reclaims the old one. Leave several GB free on the disk holding Docker's data plus about twice the database's size:

```bash
df -h / /var/lib/docker .
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB" -Atc "SELECT pg_size_pretty(pg_database_size(current_database()))"'
```

The `members_only_text` migration is one of those: it rewrites every row of the `Photo` table under an exclusive lock, about 30 seconds per 60,000 photos, and the album does not answer until it is done. A deploy waits `HEALTH_TIMEOUT` (180 s by default) for the new container, so on a very large album run `deploy/update.sh` by hand with a longer one for that release.

Migrations run automatically at start. Take a database dump first (step 9) before any upgrade. Upgrading from a release without `FORGET_KEY` in `.env.example`? Set it first: see [Upgrading from before the forget key](#upgrading-from-before-the-forget-key).

The app's port is now published on `127.0.0.1` only (`APP_BIND`). If other devices used to open the album as `http://<server>:<port>`, put Caddy in front instead (step 6); `APP_BIND=0.0.0.0` does not bring plain http back. Signing in needs https, since the session cookie is `Secure` in production, and without a proxy anyone can forge the `X-Forwarded-For` the sign-in rate limits go by. A proxy on another machine needs `APP_BIND` set to an address it can reach, a firewall that really covers the port (Docker's published ports bypass ufw), and to set `X-Forwarded-For` itself.

 In-flight photo processing is given 45 seconds to finish before the old container stops. A description backfill that is still submitting is cut short by an upgrade: the Admin page says so under that run within about an hour. Wait until no row of that run still reads "in progress" (batches already sent keep processing at Anthropic for up to a day), then run the backfill again for the remaining items; the app refuses to start a new run while one is open, so nothing is sent twice.

**After the upgrade that adds the storage check** (the `.album-install-id` marker), an existing album shows **This storage has not been claimed by this album yet** on its Admin page, once. Press **Claim this storage** on the live site — never on a staging site that shares its media folder — and cleaning up the media folder (track files left by failed imports, the count of folders with no photo) stays off until you do. If a staging site shares the folder and runs this version first, it shows the same notice; leave it alone there. See "The install marker" in §9.

### Upgrading from before the forget key

`FORGET_KEY` came with forgetting people. `deploy/update.sh` makes one when `.env` has none, but the first deploy of that release onto a checkout still on an older one is run by the older copy of the script, which knows nothing of the key (live's `main` had no hand-over to the new script before it). The album then starts without one: nothing is lost, but nobody can be forgotten for good until the next deploy's script makes it, and the Admin page says so meanwhile. So before that first deploy, give **each instance its own key** in its own `.env` — staging and live never share one, since a key is tied to the database its names were forgotten in:

**Never replace a key that already exists.** A key that has been used cannot be made again, and every name forgotten under it stops being recognized. The block below adds one only where `.env` has none (an empty `FORGET_KEY=` line from `.env.example` is dropped first), so it is safe to paste, and to paste twice; where there is a key it leaves it alone and says so:

```bash
cd /cieply/sites/cieply.com/PhotoAlbum-live          # then the same in PhotoAlbum, for staging
if sudo grep -qE '^[[:space:]]*(export[[:space:]]+)?FORGET_KEY=[^[:space:]]' .env; then
  echo "This .env already has a FORGET_KEY: leaving it alone."
else
  sudo sed -i -E '/^[[:space:]]*(export[[:space:]]+)?FORGET_KEY=[[:space:]]*$/d' .env
  sudo sed -i -e '$a\' .env                         # end the last line, so the key starts a line of its own
  echo "FORGET_KEY=$(openssl rand -base64 32)" | sudo tee -a .env >/dev/null
fi
```

If `docker-compose.override.yml` sets `FORGET_KEY` instead, leave that as it is and skip the block.

Then back each key up **separately from the database dumps**, labeled with its instance (`sudo grep -E '^[[:space:]]*(export[[:space:]]+)?FORGET_KEY=' .env` shows it; a password manager is the place for it): `deploy/update.sh` dumps only the database, and once somebody has been forgotten, that database without its key pauses forgetting and the AI helper until the key is back. If an instance has already forgotten somebody under a key and its `.env` has lost it, do not make a new one: put the original back. The script refuses to make a key for a database that keeps names under one, and says so.

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

To have the two work from one set of photographs instead, see [MOVE-MEDIA.md](MOVE-MEDIA.md) — sharing the media folder without also sharing the database does more harm than good (the install marker, §9, stops the second install from cleaning anything up, but that is all it can do), and there is a migration rule that comes with sharing both.

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
instance does. Both are called from `ci.yml` only after its `test` and
`docker` jobs pass for the pushed commit, and they deploy exactly that
commit. Each is one job with one SSH step that runs the shared
[`deploy/update.sh`](../deploy/update.sh) on the server with four
variables (`APP_DIR`, `BRANCH`, `APP_PORT`, and `DEPLOY_SHA`, the commit
CI tested). The script skips a commit older than the one already deployed
(CI runs can finish out of order), hands over to the target commit's own
copy of `update.sh` (when it is new enough to take it), dumps the database
to a `backups/` folder next to the checkout and stops if the dump fails,
resets the checkout to the commit (`.env` and `docker-compose.override.yml` are
untracked and survive), makes a `FORGET_KEY` in `.env` if there is none
(and stops instead if the database already keeps names forgotten under
one), runs `docker compose up --build -d`, waits for `/api/health`, and
prunes old images. A commit that is no longer on the
branch (force-pushed away) is skipped with a note; if the branch was
rewound past what is deployed, the older commit is deployed. A deploy rebuilds the image, so expect a short
outage of a minute or two per push; in-flight photo processing gets 45
seconds to finish first. Check the server's free disk space before
pushing a release (see step 10): a deploy that fills the disk can take
Postgres down with it.

| Branch | Workflow | Checkout | Port |
|---|---|---|---|
| `staging` | `deploy-staging.yml` | `/cieply/sites/cieply.com/PhotoAlbum` | 3005 (dev.cieply.com) |
| `main` | `deploy-production.yml` | `/cieply/sites/cieply.com/PhotoAlbum-live` | 3004 (cieply.com) |

Until the three secrets below exist, or until the instance's folder exists
on the server, a workflow prints a note and exits green. A red CI run
means no deploy; `staging` is still the rehearsal for `main`.

Staging and live deploys share one queue (one server, one small disk). A
queue holds one running and one waiting deploy, so a newer deploy of
either branch replaces a waiting one of the other, and that CI run shows
as cancelled. The next push to the branch, or re-running its deploy job,
brings it up to date.

To arm it (a private repo needs two keys: one for the runner to reach the
server, one for the server to read GitHub):

1. **Runner → server.** On the server, `ssh-keygen -t ed25519 -f
   photoalbum-actions -N ''`, append the `.pub` half to the deploy user's
   `~/.ssh/authorized_keys` (a user with passwordless sudo: the script
   runs git as the checkout's owner and docker via sudo), then add the
   repository secrets `DEPLOY_HOST` (the server's hostname, no `https://`),
   `DEPLOY_USER` and `DEPLOY_SSH_KEY` (the private half). Delete the
   private key file afterwards. Add `DEPLOY_HOST_FINGERPRINT` too, the
   server's host key fingerprint from `ssh-keygen -l -f
   /etc/ssh/ssh_host_ed25519_key.pub | cut -d ' ' -f2` on the server (it
   starts `SHA256:`); without it the runner does not check whom it hands the
   deploy key to. If the deploy then fails on the fingerprint, the server
   offered another key type: use that key's `.pub` file instead.
2. **Server → GitHub.** The checkout's owner needs a key that can read the
   repo: a read-only deploy key in their `~/.ssh` (step 4 above) or a
   personal key that already has access.
3. Push a commit to `staging` and watch the CI run under the repo's
   **Actions** tab; the deploy job runs after the tests. To redeploy
   without a commit, re-run that deploy job, or use **Run workflow** on CI
   for the branch (it tests the tip again first).

The production workflow points at a second checkout,
`PhotoAlbum-live`, with its own `.env` (`APP_PORT=3004`, `APP_URL`
`https://cieply.com`) and its own data directory — see step 13. It skips
until that folder exists.

## Security headers

Pages are served with a nonce-based Content-Security-Policy generated per request (see `src/proxy.ts`), so a reverse proxy must pass the `Content-Security-Policy` response header through unchanged and must not add its own. If you use a map tile or style provider, set `NEXT_PUBLIC_TILE_URL`, `NEXT_PUBLIC_MAP_STYLE_URL` and `NEXT_PUBLIC_MAP_GLYPHS_URL` before building the image: the policy allows exactly those hosts. `CSP_REPORT_ONLY=true` switches to reporting while you check a new provider.

Every response also carries `X-Content-Type-Options: nosniff`, and uploaded photos and videos (`/api/photos/…`) get a policy of their own that runs nothing if one is opened directly. When `APP_URL` is https the app sends `Strict-Transport-Security: max-age=31536000`, so the proxy need not add HSTS; set `HSTS_INCLUDE_SUBDOMAINS=true` to extend it to every subdomain of the album's hostname, only if all of them serve https.
