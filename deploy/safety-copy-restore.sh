#!/usr/bin/env bash
# Bring the album back from its Deep Archive safety copy (docs/SAFETY-COPY.md, "Getting everything back").
#
# Deep Archive files cannot be read straight away: each one has to be asked for first, and S3 takes up to 12 hours
# (Standard tier) or 48 hours (Bulk, about a tenth of the price) to make a readable copy, kept for RESTORE_DAYS.
# So a recovery is two steps, a day or two apart:
#
#   deploy/safety-copy-restore.sh request             # ask for the media and the newest database dump
#   deploy/safety-copy-restore.sh status              # how many are ready
#   deploy/safety-copy-restore.sh download /restore   # once all are ready: media to /restore/media, dump beside it
#
# Then follow docs/DEPLOY.md §9 "To restore on a new server" with what is in /restore.
#
# It needs credentials that may restore (an admin's, not the album server's role, which is not allowed to):
# AWS_PROFILE, or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, or an instance role. ~/.aws is
# passed through when it exists.
#
#   SAFETY_COPY_BUCKET, SAFETY_COPY_REGION   as for deploy/safety-copy.sh (it reads /etc/photoalbum-safety-copy.env too)
#   SAFETY_COPY_PREFIX   which instance's copy; required here (e.g. PhotoAlbum-live)
#   RESTORE_TIER         Bulk (default, within 48 h, ~$2.50 per TB) or Standard (within 12 h, ~$20 per TB)
#   RESTORE_DAYS         how long the readable copies stay (default 7)
#   DB_DUMP              which dump to bring back (a key under db/<prefix>/); default the newest
#
# This brings back the files as they were at the last run. To go back to before a mistake (files the album deleted,
# or an older dump), see the section on older versions in docs/SAFETY-COPY.md.
set -euo pipefail

CONFIG="${SAFETY_COPY_CONFIG:-/etc/photoalbum-safety-copy.env}"
# shellcheck disable=SC1090
if [ -f "$CONFIG" ]; then set -a; . "$CONFIG"; set +a; fi
: "${SAFETY_COPY_BUCKET:?set SAFETY_COPY_BUCKET}"
: "${SAFETY_COPY_REGION:?set SAFETY_COPY_REGION}"
: "${SAFETY_COPY_PREFIX:?set SAFETY_COPY_PREFIX, the instance folder in the bucket, e.g. PhotoAlbum-live}"
TIER="${RESTORE_TIER:-Bulk}"
DAYS="${RESTORE_DAYS:-7}"
AWS_CLI_IMAGE="${AWS_CLI_IMAGE:-amazon/aws-cli:2.31.0}"
B="$SAFETY_COPY_BUCKET"
P="$SAFETY_COPY_PREFIX"

aws_in() {
  local opts=()
  while [ "$1" != -- ]; do opts+=("$1"); shift; done
  shift
  if [ -d "$HOME/.aws" ]; then opts+=(-v "$HOME/.aws:/root/.aws:ro"); fi
  docker run --rm -i --network host -e AWS_REGION="$SAFETY_COPY_REGION" -e AWS_DEFAULT_REGION="$SAFETY_COPY_REGION" \
    -e AWS_PROFILE -e AWS_ENDPOINT_URL -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
    -e B="$B" -e TIER="$TIER" -e DAYS="$DAYS" "${opts[@]}" "$AWS_CLI_IMAGE" "$@"
}

newest_dump() {
  if [ -n "${DB_DUMP:-}" ]; then echo "$DB_DUMP"; return; fi
  aws_in -- s3api list-objects-v2 --bucket "$B" --prefix "db/$P/" --query 'Contents[].[Key]' --output text | sort | tail -n 1
}

# Every key to bring back, one per line: the media, and one dump.
keys() {
  local part
  # originals/ exists only when the album used storage Option 2 (docs/ORIGINALS-ON-S3.md).
  for part in media originals; do
    aws_in -- s3api list-objects-v2 --bucket "$B" --prefix "$P/$part/" --query 'Contents[].[Key]' --output text | { grep -v '^None$' || true; }
  done
  newest_dump
}

# The per-file work runs inside one container, 16 files at a time.
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/one.sh" <<'ONE'
#!/bin/sh
# $1: what to do, $2: the key. A file already asked for answers RestoreAlreadyInProgress, which is fine.
case "$1" in
  request)
    out=$(aws s3api restore-object --bucket "$B" --key "$2" \
      --restore-request "{\"Days\":$DAYS,\"GlacierJobParameters\":{\"Tier\":\"$TIER\"}}" 2>&1) && exit 0
    case "$out" in *RestoreAlreadyInProgress*) exit 0 ;; esac
    echo "!! $2: $out" >&2; exit 1 ;;
  status)
    aws s3api head-object --bucket "$B" --key "$2" --query Restore --output text ;;
esac
ONE
for_each_key() {
  keys > "$WORK/keys"
  aws_in -v "$WORK:/work:ro" --entrypoint sh -- -c "xargs -d '\n' -P 16 -n 1 sh /work/one.sh $1 < /work/keys"
}

case "${1:-}" in
  request)
    for_each_key request
    echo "== asked for $(wc -l < "$WORK/keys") files from s3://$B/$P ($TIER tier, readable for $DAYS days) =="
    echo "== Bulk takes up to 48 hours, Standard up to 12. Check with: $0 status =="
    ;;
  status)
    for_each_key status | awk '/ongoing-request="false"/{r++} /ongoing-request="true"/{w++} /^None/{n++}
      END{printf "ready: %d   still waiting: %d   never asked for: %d\n", r, w, n}'
    ;;
  download)
    TARGET="${2:?say where to put it: $0 download /restore}"
    mkdir -p "$TARGET/media"
    DUMP_KEY=$(newest_dump)
    # --force-glacier-transfer: read the restored copies; anything not yet restored fails loudly rather than being skipped.
    aws_in -v "$(cd "$TARGET" && pwd):/restore" -- s3 sync "s3://$B/$P/media/" /restore/media/ \
      --force-glacier-transfer --no-progress --only-show-errors
    # Option 2's originals go back into the same media folder: their keys are the album's own paths under it, so the
    # album finds them on the disk whichever storage driver it runs with.
    aws_in -v "$(cd "$TARGET" && pwd):/restore" -- s3 sync "s3://$B/$P/originals/" /restore/media/ \
      --force-glacier-transfer --no-progress --only-show-errors
    aws_in -v "$(cd "$TARGET" && pwd):/restore" -- s3 cp "s3://$B/$DUMP_KEY" "/restore/$(basename "$DUMP_KEY")" \
      --force-glacier-transfer --no-progress --only-show-errors
    echo "== media in $TARGET/media ($(find "$TARGET/media" -type f | wc -l) files), database in $TARGET/$(basename "$DUMP_KEY") =="
    echo "== next: docs/DEPLOY.md §9, 'To restore on a new server' =="
    ;;
  *)
    sed -n '2,26p' "$0"; exit 2 ;;
esac
