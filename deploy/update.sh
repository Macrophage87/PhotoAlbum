#!/usr/bin/env bash
# Update ONE Family Album instance to a commit of its branch and rebuild it.
# Idempotent; the deploy workflows run it over SSH once CI has passed, and
# you can run it by hand on the server:
#
#   APP_DIR=/cieply/sites/cieply.com/PhotoAlbum BRANCH=staging APP_PORT=3005 bash deploy/update.sh
#
# DEPLOY_SHA (set by the workflows) pins the exact commit CI tested; without
# it the script takes the tip of origin/<branch>.
#
# What it does, in order:
#   1. `git fetch` as the checkout's owner and pick the commit; a DEPLOY_SHA
#      no longer on the branch, or older than a deployed commit that still
#      is, is skipped, so CI runs finishing out of order never roll the
#      instance back (a rewound branch is followed back),
#      then re-run this script as that commit has it, so a change to it
#      takes effect in the same deploy,
#   2. dump the database to $BACKUP_DIR (a deploy runs migrations, so keep a
#      restore point — docs/DEPLOY.md step 10); a failed or truncated dump
#      stops the deploy and is not kept,
#   3. `git reset --hard <commit>` (the branch is the source of truth; .env
#      and the compose override are untracked and survive the reset),
#   3b. make FORGET_KEY in .env if it has none (printed loudly: back it up), unless the database already
#      keeps forgotten names under one: then stop, for the original to be put back,
#   4. `docker compose up --build -d` (the container applies migrations at
#      start; in-flight photo processing gets 45 s to finish),
#   5. wait for /api/health where the port is published, then prune dangling images and day-old build cache.
#
# Runs as a user with sudo (the deploy login) or as root.
# shellcheck disable=SC2016 # the single-quoted sh -c scripts expand in the container or root's shell, on purpose
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

# 1. which commit
as_owner git fetch origin "$BRANCH"
TARGET=$(as_owner git rev-parse "origin/$BRANCH")
if [ -n "${DEPLOY_SHA:-}" ]; then
  # Force-pushed away (so not in the fetch either): a later push has its own CI run and deploy. Any other git
  # error still fails the deploy.
  ON_BRANCH=0
  if as_owner git cat-file -e "$DEPLOY_SHA^{commit}" 2>/dev/null; then
    as_owner git merge-base --is-ancestor "$DEPLOY_SHA" "origin/$BRANCH" || ON_BRANCH=$?
  else
    ON_BRANCH=1
  fi
  if [ "$ON_BRANCH" = 1 ]; then
    echo "== $DEPLOY_SHA is no longer on origin/$BRANCH — nothing to do =="
    exit 0
  elif [ "$ON_BRANCH" != 0 ]; then
    echo "!! could not check $DEPLOY_SHA against origin/$BRANCH" >&2
    exit 1
  fi
  CURRENT=$(as_owner git rev-parse HEAD)
  # Older than the deployed commit: skip, unless the branch was rewound past what is deployed.
  if [ "$CURRENT" != "$DEPLOY_SHA" ] &&
    as_owner git merge-base --is-ancestor "$CURRENT" "origin/$BRANCH" &&
    as_owner git merge-base --is-ancestor "$DEPLOY_SHA" "$CURRENT"; then
    echo "== $DEPLOY_SHA is older than the deployed $CURRENT — nothing to do =="
    exit 0
  fi
  TARGET=$DEPLOY_SHA
fi

# The rest of the deploy is the target commit's own update.sh, not whatever the checkout had before; the guard
# stops that copy from doing this again. A copy from before this hand-over (a rollback) would reset to the branch
# tip and skip the dump checks, so this one carries on instead.
if [ -z "${UPDATE_SH_REEXEC:-}" ]; then
  SCRIPT=$(as_owner git show "$TARGET:deploy/update.sh" 2>/dev/null) || SCRIPT=
  if [[ $SCRIPT != *UPDATE_SH_REEXEC* ]]; then
    echo "== $TARGET's update.sh predates the hand-over — carrying on with this one =="
  else
    exec env UPDATE_SH_REEXEC=1 APP_DIR="$APP_DIR" BRANCH="$BRANCH" APP_PORT="$APP_PORT" BACKUP_DIR="$BACKUP_DIR" \
      HEALTH_TIMEOUT="$HEALTH_TIMEOUT" DEPLOY_SHA="$TARGET" bash -c "$SCRIPT" update.sh
  fi
fi

# 2. restore point (only if the stack is already running)
if as_root docker compose ps --status running --services 2>/dev/null | grep -qx db; then
  as_root mkdir -p "$BACKUP_DIR"
  # Every member's email and every name in the album: readable by root only, including dumps from before that rule.
  as_root find "$BACKUP_DIR" -maxdepth 1 -name 'db-pre-deploy-*.sql.gz' -perm /077 -exec chmod 600 {} +
  # To the second, so a quick redeploy never writes over the restore point of the deploy before it.
  DUMP="$BACKUP_DIR/db-pre-deploy-$(date +%F-%H%M%S).sql.gz"
  # Written under a temporary name and renamed once checked, so a failed dump never sits there looking like a backup.
  PARTIAL="$DUMP.partial"
  # The container's own POSTGRES_USER/POSTGRES_DB, so a role or database renamed in .env is dumped too. pipefail
  # (set above) makes a failing pg_dump fail the pipeline instead of leaving gzip's empty file as "the backup".
  if ! as_root docker compose exec -T db sh -c 'exec pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip | as_root sh -c 'umask 077 && exec cat > "$1"' sh "$PARTIAL"; then
    as_root rm -f "$PARTIAL"
    echo "!! pg_dump failed — not deploying without a restore point" >&2
    exit 1
  fi
  # pg_dump writes this trailer last, so its presence means the dump ran to the end.
  TRAILER=$(as_root gzip -cd "$PARTIAL" | tail -n 20) || TRAILER=
  case "$TRAILER" in
    *'PostgreSQL database dump complete'*) ;;
    *)
      as_root rm -f "$PARTIAL"
      echo "!! the database dump is empty or truncated — not deploying without a restore point" >&2
      exit 1
      ;;
  esac
  as_root mv "$PARTIAL" "$DUMP"
  echo "== database dumped to $DUMP ($(as_root du -h "$DUMP" | cut -f1)) =="
fi

# 3. code
as_owner git reset --hard "$TARGET"
echo "== at $(as_owner git rev-parse --short HEAD) =="

# 3b. FORGET_KEY: the secret forgotten people's names are hashed under (docs/DEPLOY.md). Made once if .env has none.
# It is not in the database dumps above, so it has to be backed up with .env; lost or changed, names forgotten under
# it are no longer recognized, and forgetting and the AI helper pause until it is put back. `export FORGET_KEY=…`
# counts (compose reads it), and so does a key kept in the override file instead.
KEY_LINE='^[[:space:]]*(export[[:space:]]+)?FORGET_KEY='
NEED_KEY=
if as_root test -f .env && ! as_root grep -qE "${KEY_LINE}[^[:space:]]" .env; then
  if as_root grep -qs FORGET_KEY docker-compose.override.yml; then
    echo "== .env has no FORGET_KEY, but docker-compose.override.yml names it: making none (make sure it holds the key) =="
  else
    NEED_KEY=1
  fi
fi
# Stopping here leaves the checkout at the new commit, but nothing is rebuilt, so the album keeps running as it was.
not_deployed() {
  echo "!! Not deployed: the checkout is at $(as_owner git rev-parse --short HEAD), but nothing was rebuilt and the album" >&2
  echo "!! keeps running its previous build. Once .env has the key, re-run this deploy (its deploy job in the CI run," >&2
  echo "!! or this script with the same variables)." >&2
  exit 1
}
if [ -n "$NEED_KEY" ]; then
  # A database that already keeps names under a key needs that key put back, never a new one. Ask it (step 4 starts
  # it anyway); to_jsonb, so a database from before the forget key, without those columns, reads as having none.
  KEPT=$(as_root docker compose up -d --wait db >/dev/null 2>&1 &&
    as_root docker compose exec -T db sh -c 'exec psql -XAtq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT to_regclass('"AppSetting"') IS NOT NULL AS has_setting, to_regclass('"ForgottenName"') IS NOT NULL AS has_names \gset
\if :has_setting
SELECT count(*) AS fingerprints FROM "AppSetting" s WHERE to_jsonb(s)->>'forgetKeyFingerprint' LIKE '1:%' \gset
\else
\set fingerprints 0
\endif
\if :has_names
SELECT count(*) AS v1_names FROM "ForgottenName" n WHERE (to_jsonb(n)->>'keyVersion')::int = 1 \gset
\else
\set v1_names 0
\endif
SELECT CASE WHEN :fingerprints + :v1_names > 0 THEN 'kept' ELSE 'none' END;
SQL
  ) || KEPT=
  case "$KEPT" in
    none) ;;
    kept)
      echo "!! $APP_DIR/.env has no FORGET_KEY, but its database already keeps forgotten names under one. Not making a" >&2
      echo "!! new key: put the original FORGET_KEY back in .env from its backup. Under any other key those names are" >&2
      echo "!! not recognized, and forgetting and the AI helper stay paused." >&2
      not_deployed
      ;;
    *)
      echo "!! $APP_DIR/.env has no FORGET_KEY, and the database could not be asked whether it keeps names under one." >&2
      echo "!! Not making a key blind: put the original back from its backup (or, if this album never had one, add" >&2
      echo "!! FORGET_KEY= with the output of openssl rand -base64 32)." >&2
      not_deployed
      ;;
  esac
  KEY=$(openssl rand -base64 32)
  # Handed over on stdin (printf is a bash builtin), never as an argument, so it shows in neither ps nor sudo's log.
  # Written in place (not replaced), so .env keeps its owner and mode.
  printf 'FORGET_KEY=%s\n' "$KEY" |
    as_root sh -c 'tmp=$(mktemp) && grep -vE "^[[:space:]]*(export[[:space:]]+)?FORGET_KEY=" .env > "$tmp"; cat >> "$tmp" && cat "$tmp" > .env && rm -f "$tmp"'
  unset KEY
  echo "!! made a new FORGET_KEY in $APP_DIR/.env. Back it up now, somewhere other than $BACKUP_DIR (the database dumps do not contain it)." >&2
fi

# 4. build + (re)start
as_root docker compose up --build -d

# 5. health, where the app's port is really published: APP_BIND may be a LAN address rather than loopback.
ADDR=$(as_root docker compose port app 3000 2>/dev/null | head -n 1) || ADDR=
case "$ADDR" in
  '' | *' '*) ADDR="127.0.0.1:$APP_PORT" ;;
  0.0.0.0:*) ADDR="127.0.0.1:${ADDR##*:}" ;;
  '[::]:'* | ':::'*) ADDR="[::1]:${ADDR##*:}" ;;
esac
for ((i = 0; i < HEALTH_TIMEOUT; i += 5)); do
  if curl -gfs "http://$ADDR/api/health" >/dev/null 2>&1; then
    as_root docker image prune -f >/dev/null
    # Build cache is never reclaimed by `image prune`; every deploy adds a few GB, and on 2026-09-19 forty GB of
    # it filled the data disk and took Postgres down. Keep only what the last day of builds can reuse.
    as_root docker builder prune -a -f --filter until=24h >/dev/null
    echo "== healthy at $ADDR at $(date -Is) =="
    exit 0
  fi
  sleep 5
done
echo "!! app did not report healthy within ${HEALTH_TIMEOUT}s — docker compose logs app" >&2
as_root docker compose logs --no-log-prefix --tail 40 app >&2 || true
exit 1
