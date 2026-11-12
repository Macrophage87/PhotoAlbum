#!/usr/bin/env bash
# Nightly safety copy of ONE Family Album instance to S3 Glacier Deep Archive (docs/SAFETY-COPY.md).
#
# Run it as root from cron on the album's server, for the live instance:
#
#   15 4 * * * root /cieply/sites/cieply.com/PhotoAlbum-live/deploy/safety-copy.sh >> /var/log/photoalbum-safety-copy.log 2>&1
#
# Settings come from the environment or from /etc/photoalbum-safety-copy.env (SAFETY_COPY_CONFIG to use another):
#
#   APP_DIR               the instance's checkout, the folder its stack was started from
#   SAFETY_COPY_BUCKET    the bucket infra/aws/safety-copy made (its BucketName output)
#   SAFETY_COPY_REGION    that bucket's region, which is NOT the server's region
#   SAFETY_COPY_PREFIX    folder for this instance in the bucket; default: the checkout's folder name
#   MEDIA_SOURCE          the media root on this host; default: whatever the running app mounts at /data/photos
#                         (the photos volume, or the drive docs/MOVE-MEDIA.md moved it to)
#   SAFETY_COPY_SHRINK_LIMIT  percent; if the media has fewer files than last night by more than this (and by more
#                         than 100 files), nothing is marked deleted in the copy and the run fails, so a wrong or
#                         unmounted drive is noticed rather than mirrored (default 10)
#   SAFETY_COPY_PING_URL  optional; fetched after a run that went through, for a dead-man's-switch monitor
#
# What it does, in order:
#   1. dump the database (checked for pg_dump's closing line, as deploy/update.sh does) and upload it to
#      db/<prefix>/db-<date>.sql.gz, where the bucket retires old dumps on its own,
#   2. mirror the media root to <prefix>/media/ with `aws s3 sync`, straight into DEEP_ARCHIVE; only new and changed
#      files are sent. Files the album deleted get a delete marker, and the bucket keeps the old version (and its
#      lock) for as long as the stack says,
#   3. write <prefix>/last-success.json (in S3 Standard, so it reads at once), which says when and how much.
#
# The server's role can add files and delete markers but cannot remove a stored version or lift its lock, so a
# mistake here (or someone on the server) cannot destroy what is already in the copy.
#
# AWS credentials come from the EC2 instance's role through the instance metadata service; the AWS CLI runs in a
# pinned container on the host network, so nothing has to be installed on the server and IMDSv2's default hop
# limit of 1 is enough.
set -euo pipefail

CONFIG="${SAFETY_COPY_CONFIG:-/etc/photoalbum-safety-copy.env}"
# shellcheck disable=SC1090 # a file of KEY=value lines the operator writes
if [ -f "$CONFIG" ]; then set -a; . "$CONFIG"; set +a; fi

: "${APP_DIR:?set APP_DIR, e.g. /cieply/sites/cieply.com/PhotoAlbum-live}"
: "${SAFETY_COPY_BUCKET:?set SAFETY_COPY_BUCKET, the BucketName output of infra/aws/safety-copy}"
: "${SAFETY_COPY_REGION:?set SAFETY_COPY_REGION, the region the bucket is in}"
PREFIX="${SAFETY_COPY_PREFIX:-$(basename "$APP_DIR")}"
SHRINK_LIMIT="${SAFETY_COPY_SHRINK_LIMIT:-10}"
STATE_DIR="${SAFETY_COPY_STATE_DIR:-/var/lib/photoalbum-safety-copy}/$PREFIX"
# Pinned: 2.23+ sends the checksum S3 Object Lock requires on every upload.
AWS_CLI_IMAGE="${AWS_CLI_IMAGE:-amazon/aws-cli:2.31.0}"
DEST="s3://$SAFETY_COPY_BUCKET/$PREFIX"

if [ "$(id -u)" != 0 ]; then echo "!! run as root (it reads the media volume and talks to docker)" >&2; exit 1; fi
# Keep the dump and the state readable by root only: the dump holds every member's address and every name.
umask 077
mkdir -p "$STATE_DIR"

# One run at a time: the first copy of a big library takes hours and must not be joined by the next night's.
exec 9>"$STATE_DIR/lock"
if ! flock -n 9; then echo "== $(date -Is) a safety copy of $PREFIX is still running; skipping =="; exit 0; fi

cd "$APP_DIR"
echo "== $(date -Is) safety copy of $APP_DIR to $DEST ($SAFETY_COPY_REGION) =="

# The CLI in a throwaway container. Extra arguments before `--` are docker options (mounts).
aws_in() {
  local opts=()
  while [ "$1" != -- ]; do opts+=("$1"); shift; done
  shift
  docker run --rm --network host -e AWS_REGION="$SAFETY_COPY_REGION" -e AWS_DEFAULT_REGION="$SAFETY_COPY_REGION" \
    -e AWS_ENDPOINT_URL -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN "${opts[@]}" "$AWS_CLI_IMAGE" "$@"
}

# Where the media is. Asked of the running app, so a move to another drive (docs/MOVE-MEDIA.md) is followed.
if [ -z "${MEDIA_SOURCE:-}" ]; then
  APP_CID=$(docker compose ps -q app)
  if [ -z "$APP_CID" ]; then echo "!! the app is not running here and MEDIA_SOURCE is not set" >&2; exit 1; fi
  MEDIA_SOURCE=$(docker inspect "$APP_CID" --format '{{range .Mounts}}{{if eq .Destination "/data/photos"}}{{.Source}}{{end}}{{end}}')
fi
if [ ! -f "$MEDIA_SOURCE/.album-install-id" ]; then
  # An empty or unmounted folder must never be taken for an album that deleted everything.
  echo "!! $MEDIA_SOURCE has no .album-install-id — not the album's media root, or not mounted; nothing copied" >&2
  exit 1
fi

# 1. the database
STAMP=$(date +%F)
DUMP="$STATE_DIR/db-$STAMP.sql.gz"
PARTIAL="$DUMP.partial"
rm -f "$STATE_DIR"/db-*.sql.gz "$STATE_DIR"/db-*.partial
if ! docker compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$PARTIAL"; then
  rm -f "$PARTIAL"; echo "!! pg_dump failed; nothing copied" >&2; exit 1
fi
TRAILER=$(gzip -cd "$PARTIAL" | tail -n 20) || TRAILER=
case "$TRAILER" in
  *'PostgreSQL database dump complete'*) mv "$PARTIAL" "$DUMP" ;;
  *) rm -f "$PARTIAL"; echo "!! the database dump is empty or truncated; nothing copied" >&2; exit 1 ;;
esac
DB_KEY="db/$PREFIX/db-$STAMP.sql.gz"
aws_in -v "$STATE_DIR:/state:ro" -- s3 cp "/state/$(basename "$DUMP")" "s3://$SAFETY_COPY_BUCKET/$DB_KEY" \
  --storage-class DEEP_ARCHIVE --no-progress --only-show-errors
DB_BYTES=$(stat -c %s "$DUMP")
rm -f "$DUMP"
echo "== database: $DB_KEY ($DB_BYTES bytes) =="

# 2. the media
FILES=$(find "$MEDIA_SOURCE" -type f | wc -l)
BYTES=$(du -sb "$MEDIA_SOURCE" | cut -f1)
LAST=$(cat "$STATE_DIR/last-file-count" 2>/dev/null || echo 0)
DELETE=(--delete)
SHRANK=0
# A few deletions are ordinary; only a big drop at once (more than the limit, and more than 100 files) stops it.
if [ "$LAST" -gt 0 ] && [ $((LAST - FILES)) -gt 100 ] && [ $((FILES * 100)) -lt $((LAST * (100 - SHRINK_LIMIT))) ]; then
  echo "!! the media has $FILES files, last night $LAST: more than $SHRINK_LIMIT% fewer. Copying what is there, marking" >&2
  echo "!! nothing deleted. If that many really went, run once with SAFETY_COPY_SHRINK_LIMIT=100." >&2
  DELETE=()
  SHRANK=1
fi
aws_in -v "$MEDIA_SOURCE:/media:ro" -- s3 sync /media "$DEST/media/" "${DELETE[@]}" \
  --storage-class DEEP_ARCHIVE --no-progress --only-show-errors
echo "== media: $FILES files, $BYTES bytes =="

if [ "$SHRANK" = 1 ]; then exit 1; fi
echo "$FILES" > "$STATE_DIR/last-file-count"

# 3. the receipt
printf '{"finishedAt":"%s","mediaFiles":%s,"mediaBytes":%s,"database":"%s","databaseBytes":%s}\n' \
  "$(date -Is)" "$FILES" "$BYTES" "$DB_KEY" "$DB_BYTES" > "$STATE_DIR/last-success.json"
# Kept in S3 Standard (a few bytes) so it can be read without waiting on Deep Archive.
aws_in -v "$STATE_DIR:/state:ro" -- s3 cp /state/last-success.json "$DEST/last-success.json" \
  --storage-class STANDARD --no-progress --only-show-errors
if [ -n "${SAFETY_COPY_PING_URL:-}" ]; then curl -fsS -m 10 --retry 3 -o /dev/null "$SAFETY_COPY_PING_URL" || true; fi
echo "== $(date -Is) done =="
