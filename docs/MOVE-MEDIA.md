# Moving the album's media to another drive

The photographs, clips and scans outgrow a boot disk long before anything else does. This is how to move them onto
a second drive without losing anything, and how to have the staging site and the live site work from one set of
media rather than two.

Everything here is done from the folder the stack was started from (`~/photoalbum` in [DEPLOY.md](DEPLOY.md)), as
the user that owns it.

## What is on the drive, and what is not

| What | Where it lives now | Size |
|---|---|---|
| Originals and renditions | Docker volume `photoalbum_photos`, mounted at `/data/photos` inside the container | nearly all of it |
| The database | Docker volume `photoalbum_pgdata` | small |
| Takeout archives waiting to be imported | Docker volume `photoalbum_imports` | temporary |
| ML model weights | Docker volume `photoalbum_ml-models` | ~2 GB, re-downloadable |

Under the media root there is exactly one folder, `photos/`, and under it one folder per item named after its id:

```
photos/cmu0adw74001i9k7dz8vadb3c/original.jpg     the file as it was uploaded, never written over
photos/cmu0adw74001i9k7dz8vadb3c/medium.webp      renditions, re-made from the original whenever they need to be
photos/cmu0adw74001i9k7dz8vadb3c/thumb.webp
photos/cmu0adw7g001j9k7d41bidem8/poster.jpg       a clip's still
photos/cmu0adw7g001j9k7d41bidem8/video.mp4
```

**The database is the index.** Those folder names come from rows in Postgres, and the path to every file is held in
the `Photo` table's `storageKey`, `originalPath` and `renditions` columns. The media folder on its own is a heap of
files named after nothing. Keep that in mind for the whole of this document — especially the staging part, where it
is the difference between sharing data and quietly corrupting it.

Check how much you are about to move:

```bash
docker system df -v | grep photoalbum_photos
sudo du -sh "$(docker volume inspect photoalbum_photos --format '{{ .Mountpoint }}')"
```

## Before you start

- Take a backup and make sure it is somewhere other than either drive. The backup script is in [DEPLOY.md §9](DEPLOY.md).
- The new drive needs room for the media *and* the album's future. Media grows; the database barely does.
- Set aside about ten minutes of downtime, whatever the size of the library. The long copy happens while the album
  is still running; only the second, short pass needs it stopped.
- Do not delete anything from the old drive until the checks at the end have passed. The old copy is the rollback.

## Part 1 — Prepare the new drive

Find it, and be sure of which one it is before formatting anything:

```bash
lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT,MODEL
```

If it is a new drive with nothing on it, give it a filesystem. Use **ext4**, **xfs** or **btrfs** — exFAT, NTFS and
FAT have no POSIX ownership, and the album's container runs as an unprivileged user that needs to own its files:

```bash
sudo mkfs.ext4 -L album /dev/sdX1      # check the device name twice; this erases it
```

Mount it at a fixed path, by UUID so it survives a device-name change:

```bash
sudo mkdir -p /mnt/album
blkid /dev/sdX1                         # copy the UUID
sudo tee -a /etc/fstab >/dev/null <<'FSTAB'
UUID=PASTE-THE-UUID-HERE  /mnt/album  ext4  defaults,noatime  0  2
FSTAB
sudo mount -a
mountpoint -q /mnt/album && echo "mounted"
```

Two things worth doing now rather than after the first incident:

- **Do not use `nofail`.** It sounds friendly, but it means that if the drive is missing at boot the machine carries
  on without it — and the album then writes into the bare `/mnt/album` folder on the boot disk, where the files look
  fine until the drive comes back and hides them.
- **Make the empty mount point unwritable**, so a missing drive fails loudly instead of silently filling the boot
  disk. With the drive unmounted, `sudo chattr +i /mnt/album`. The flag applies to the empty folder underneath, not
  to the mounted filesystem, so it costs nothing while the drive is there.

Make the folder and give it to the user the container runs as. Ask the image rather than assuming:

```bash
docker compose run --rm --no-deps --entrypoint sh app -c 'id'
# uid=1000(node) gid=1000(node) ...

sudo mkdir -p /mnt/album/photos
sudo chown -R 1000:1000 /mnt/album/photos
sudo chmod 750 /mnt/album/photos
```

## Part 2 — Copy the media

The first pass runs with the album up. This is safe because an original is never written over — every rendition is
made afresh from it — so the only files that can change under the copy are renditions, and the second pass catches
those.

```bash
OLD="$(docker volume inspect photoalbum_photos --format '{{ .Mountpoint }}')"
sudo rsync -aH --info=progress2 "$OLD/" /mnt/album/photos/
```

Now stop the album and let it finish what it was doing. Compose gives the container 45 seconds to put down whatever
it was processing:

```bash
docker compose stop app worker
```

Second pass. `--delete` removes anything from the new copy that was deleted from the old one during the first pass:

```bash
sudo rsync -aH --delete --info=progress2 "$OLD/" /mnt/album/photos/
sudo chown -R 1000:1000 /mnt/album/photos
```

Confirm the two trees are identical, byte for byte. This reads everything twice, so on a large library it is worth
starting and going to make a cup of tea:

```bash
sudo diff -r --brief "$OLD" /mnt/album/photos && echo "identical"
```

## Part 3 — Point the album at the new drive

`PHOTO_STORAGE_ROOT` stays exactly as it is. It is the path *inside* the container, and it appears in no database
row — what changes is where that path comes from on the host. Nothing in Postgres needs rewriting.

Create `docker-compose.override.yml` beside `docker-compose.yml`:

```yaml
services:
  app:
    volumes:
      - /mnt/album/photos:/data/photos
  worker:
    volumes:
      - /mnt/album/photos:/data/photos
```

Check that it took, rather than trusting it:

```bash
docker compose config | grep -B2 -A2 '/data/photos'
```

If that still shows the `photos` named volume, your Compose version appended the bind mount instead of replacing it.
Edit `docker-compose.yml` directly in that case, swapping `- photos:/data/photos` for `- /mnt/album/photos:/data/photos`
in both the `app` and `worker` services.

Start it up:

```bash
docker compose up -d
curl -fsS localhost:${APP_PORT:-3000}/api/health && echo
```

## Part 4 — Check nothing was lost

Open the album and look at a trip: thumbnails, a full-size photo, a clip, a scan. Then ask the database for every
file it believes in and check each one is really there. This covers originals, renditions and clips' posters:

```bash
docker compose exec -T db psql -U photoalbum -At photoalbum > /tmp/album-keys.txt <<'SQL'
SELECT "originalPath" AS key FROM "Photo" WHERE "originalPath" <> 'pending'
UNION
SELECT r.value->>'key' FROM "Photo", jsonb_each("renditions") AS r
  WHERE "renditions" IS NOT NULL AND r.value->>'key' IS NOT NULL
UNION
SELECT v.value->>'key' FROM "Photo", jsonb_each("videoRenditions") AS v
  WHERE "videoRenditions" IS NOT NULL AND v.value->>'key' IS NOT NULL;
SQL

wc -l < /tmp/album-keys.txt
missing=0
while read -r key; do
  [ -f "/mnt/album/photos/$key" ] || { echo "MISSING $key"; missing=$((missing + 1)); }
done < /tmp/album-keys.txt
echo "$missing missing"
```

`0 missing` is the answer you want. An item still being processed has `originalPath` of `pending` and no renditions
yet, which is why it is skipped.

The other direction — files on disk that no row mentions — is not a failure. Trashing an item leaves its files until
an admin deletes it for good, and a failed upload can leave one behind.

## Part 5 — Tidy up

**Update the backup script.** This is the step people forget, and the failure is silent: the script in DEPLOY.md
reads the *volume*, which the app no longer uses. Change the photos line to read the host folder:

```bash
tar czf "$DEST/photos-$STAMP.tgz" -C /mnt/album/photos .
```

Run it once by hand and check the archive is the size you expect before trusting the cron job again.

Leave the old volume alone for a week or two of normal use. When you are sure:

```bash
docker volume rm photoalbum_photos
```

## Sharing one set of media between staging and main

As set up in [DEPLOY.md §13](DEPLOY.md), staging is a second folder with its own `.env`, and Compose names its
volumes after that folder — so it gets its own database and its own media. To have both sites work from one set of
data, that has to change on both counts.

> **The media alone is not "the same data".** Point two installs at one media folder while they keep separate
> databases and you get something worse than two separate albums: each shows only its own uploads, and emptying the
> trash in one deletes files the other still lists, leaving broken pictures in a database that thinks they are fine.
> If you share the folder, share the database too.

| | Media | Database | What it means |
|---|---|---|---|
| **A. One album, two windows** | shared | shared | Both sites show the same photographs, and a change on either is a change to both. This is what "the same data" means. |
| **B. Shared folder only** | shared | separate | Don't. Each site can delete the other's files. |
| **C. Staging on a copy** | copy | copy | Staging is a safe place to try things; it drifts from live until you refresh it. |

### A. One album, two windows

In the staging folder's `docker-compose.override.yml`:

```yaml
services:
  app:
    volumes:
      - /mnt/album/photos:/data/photos
    environment:
      # The live stack's database, reached over the Docker network it is on.
      DATABASE_URL: postgresql://photoalbum:PASSWORD@db:5432/photoalbum
    networks:
      - default
      - photoalbum_default
networks:
  photoalbum_default:
    external: true
```

and in the staging `.env`:

```ini
APP_URL=https://staging.album.example.com
APP_PORT=3100
# Let the live stack do the background work. Two sets of workers on one database both run, and staging's would
# process the family's real photographs with whatever code is being tried out.
RUN_WORKER=false
```

Then, in the staging folder, `docker compose up -d app` — start only `app`, so staging does not bring up a second
Postgres that nothing uses.

Three rules come with this arrangement, and they are not optional:

1. **Staging's migrations are production's migrations.** Every container runs `prisma migrate deploy` as it starts
   (`scripts/entrypoint.sh`). The moment staging starts with newer code, the shared database is migrated, and the
   live site — still on older code — is running against a schema it was not built for. Additive changes pass
   unnoticed; a renamed or dropped column takes the album down. Deploy staging from a commit the live site is ready
   to move to, and move the live site promptly after.
2. **Nothing destructive on staging.** It is the family's real album. Emptying the trash, deleting a trip or
   re-importing a Takeout archive on staging does all of that for real.
3. **Sign-ins are shared, cookies are not.** Same users, same invites, same share links; everyone signs in to the
   staging hostname separately, and a magic link from staging lands on staging.

If staging also needs the Takeout inbox, add `- /mnt/album/imports:/data/imports` to its volumes and move the live
stack's inbox there the same way. The ML weights are not data and can stay separate, or be shared to save the 2 GB.

### C. Staging on a copy

If what you want from staging is somewhere to try a change before the family sees it, give it a copy and refresh it
when you like. `~/refresh-staging.sh`:

```bash
#!/bin/bash
set -e
cd ~/photoalbum-staging
docker compose stop app
# The database, as it is right now.
cd ~/photoalbum && docker compose exec -T db pg_dump -U photoalbum photoalbum > /tmp/live.sql
cd ~/photoalbum-staging
docker compose exec -T db psql -U photoalbum -c 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;' photoalbum
docker compose exec -T db psql -U photoalbum photoalbum < /tmp/live.sql
rm /tmp/live.sql
# The media. --delete so items deleted from the live album go from the copy too.
sudo rsync -aH --delete /mnt/album/photos/ /mnt/album-staging/photos/
sudo chown -R 1000:1000 /mnt/album-staging/photos
docker compose up -d app
```

A copy costs a second full-size library. If that is what the new drive was for, option A is the reason to prefer it.

## If something goes wrong

| What you see | What it usually is |
|---|---|
| Every thumbnail is a broken image | The container cannot read the folder. `ls -n /mnt/album/photos` and compare the owner with `id` inside the container. |
| Uploads fail, the log says `EACCES` | Same, for writing. `sudo chown -R 1000:1000 /mnt/album/photos`. |
| An item sits at "Getting the scan ready…" | The worker cannot write. If you run the separate worker container, it needs the bind mount too. |
| The boot disk fills up and the album looks empty | The drive was not mounted when the stack started, so it has been writing to the folder underneath. Stop the stack, unmount nothing, check `mountpoint -q /mnt/album`, move any files written to the bare folder into the real one, and see the `nofail` note in Part 1. |
| Photos are there but the album does not know them | You restored media without the matching database, or the other way round. They are one thing; restore both from the same night's backup. |

## Rolling back

Nothing in the database changed, so going back is just going back to the old files:

```bash
docker compose stop app worker
rm docker-compose.override.yml     # or put the named volume back in docker-compose.yml
docker compose up -d
```

That is why the old volume stays until the checks have passed and the album has been used for a while.
