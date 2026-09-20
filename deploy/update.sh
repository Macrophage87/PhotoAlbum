#!/usr/bin/env bash
# Update ONE Family Album instance to the tip of its branch and rebuild it.
# Idempotent; the deploy workflows run it over SSH, and you can run it by
# hand on the server:
#
#   APP_DIR=/cieply/sites/cieply.com/PhotoAlbum BRANCH=staging APP_PORT=3005 bash deploy/update.sh
#
# What it does, in order:
#   1. dump the database to $BACKUP_DIR (a deploy runs migrations, so keep a
#      restore point — docs/DEPLOY.md step 10),
#   2. `git fetch` + `git reset --hard origin/<branch>` as the checkout's
#      owner (the branch is the source of truth; .env and the compose
#      override are untracked and survive the reset),
#   3. `docker compose up --build -d` (the container applies migrations at
#      start; in-flight photo processing gets 45 s to finish),
#   4. wait for /api/health, then prune dangling images and day-old build cache.
#
# Runs as a user with sudo (the deploy login) or as root.
set -euo pipefail

: "${APP_DIR:?set APP_DIR, e.g. /cieply/sites/cieply.com/PhotoAlbum}"
: "${BRANCH:?set BRANCH, e.g. staging}"
: "${APP_PORT:?set APP_PORT, the host port from .env, e.g. 3005}"
BACKUP_DIR="${BACKUP_DIR:-$(dirname "$APP_DIR")/backups}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"

as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
OWNER=$(stat -c %U "$APP_DIR")
as_owner() { if [ "$(id -un)" = "$OWNER" ]; then "$@"; else sudo -Hu "$OWNER" "$@"; fi; }

cd "$APP_DIR"
echo "== $APP_DIR: updating to origin/$BRANCH =="

# 1. restore point (only if the stack is already running)
if as_root docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  as_root mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%F-%H%M)
  as_root sh -c "docker compose exec -T db pg_dump -U photoalbum photoalbum | gzip > '$BACKUP_DIR/db-pre-deploy-$STAMP.sql.gz'"
  echo "== database dumped to $BACKUP_DIR/db-pre-deploy-$STAMP.sql.gz =="
fi

# 2. code
as_owner git fetch origin "$BRANCH"
as_owner git reset --hard "origin/$BRANCH"
echo "== at $(as_owner git rev-parse --short HEAD) =="

# 3. build + (re)start
as_root docker compose up --build -d

# 4. health
for ((i = 0; i < HEALTH_TIMEOUT; i += 5)); do
  if curl -fs "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then
    as_root docker image prune -f >/dev/null
    # Build cache is never reclaimed by `image prune`; every deploy adds a few GB, and on 2026-09-19 forty GB of
    # it filled the data disk and took Postgres down. Keep only what the last day of builds can reuse.
    as_root docker builder prune -a -f --filter until=24h >/dev/null
    echo "== healthy on port $APP_PORT at $(date -Is) =="
    exit 0
  fi
  sleep 5
done
echo "!! app did not report healthy within ${HEALTH_TIMEOUT}s — docker compose logs app" >&2
as_root docker compose logs --no-log-prefix --tail 40 app >&2 || true
exit 1
