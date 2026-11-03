#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into the compose stack, then run
# the restore check. See "Backup and restore" in docs/development.md.
#
#   scripts/restore.sh [--force] DIR
#
# It verifies the backup's checksums, starts the postgres service, and
# refuses a stack that already holds data (a database JJ Bot has opened, a
# workspace volume in its namespace, or a running app) unless --force is
# given. --force stops the app, removes the namespace's sandboxes and
# workspace volumes and recreates the database, so the backup replaces
# everything. It then restores the database and the workspace volumes, under
# the target stack's docker namespace, and runs the restore check: the
# database's migration level against this build, its records against the
# backup's, and the stored secrets the configured JJ_SECRET_KEY cannot read.
# The app is left stopped: start it with `docker compose up -d --wait`.
#
# Exits 1 when the backup is damaged, the stack refuses it, or the restored
# database is newer than this build (which then refuses to start on it).
#
# Runs from the repository root with `docker compose`, so COMPOSE_FILE,
# COMPOSE_PROJECT_NAME and .env apply as they do to the stack.
# JJ_BACKUP_IMAGE is the image the throwaway containers use (default
# jj-sandbox:base-1, which the stack builds).
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}
fail() {
  echo "restore: $*" >&2
  exit 1
}

force=false
dir=
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --force) force=true ;;
    -*) fail "unknown option $1 (see --help)" ;;
    *)
      [ -z "$dir" ] || fail "too many arguments (see --help)"
      dir=$1
      ;;
  esac
  shift
done
[ -n "$dir" ] || fail "name the backup directory (see --help)"
dir=$(cd "$dir" && pwd) || fail "no backup directory $dir"

cd "$(dirname "$0")/.."
image=${JJ_BACKUP_IMAGE:-jj-sandbox:base-1}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

for file in manifest.json check.env database.dump SHA256SUMS; do
  [ -f "$dir/$file" ] || fail "$dir is not a JJ Bot backup: $file is missing."
done
if ! grep -q '"format": "jj-bot-backup"' "$dir/manifest.json" || ! grep -q '"version": 1,' "$dir/manifest.json"; then
  fail "$dir/manifest.json is not a version 1 JJ Bot backup manifest."
fi
echo "Checking $dir"
(cd "$dir" && sha256 -c --quiet SHA256SUMS) || fail "the backup is damaged: its checksums do not match."
docker image inspect "$image" >/dev/null 2>&1 || fail "the image $image is missing; build the stack (docker compose build) or set JJ_BACKUP_IMAGE."

backed() { sed -n "s/^$1=//p" "$dir/check.env"; }
check() {
  docker compose run --rm --no-deps -T app node --import tsx apps/api/src/data-check.ts "$@"
}

docker compose up --detach --wait postgres
target=$(check --env) || [ -n "${target:-}" ] || fail "the data check could not read the stack's database (an app image without apps/api/src/data-check.ts needs \`docker compose build app\`)."
current() { sed -n "s/^$1=//p" <<<"$target"; }
namespace=$(current docker_namespace)
source_namespace=$(backed docker_namespace)

volumes=$(docker volume ls --quiet --filter "label=jj.sandbox=1" --filter "label=jj.sandbox.namespace=$namespace")
app=$(docker compose ps --status running --quiet app)
held=()
[ "$(current schema_state)" = empty ] || held+=("a database at schema $(current schema_state) (bots: $(current bots), tasks: $(current tasks))")
[ -z "$volumes" ] || held+=("workspace volumes in the namespace $namespace ($(wc -l <<<"$volumes" | tr -d ' '))")
[ -z "$app" ] || held+=("a running app")
if [ ${#held[@]} -gt 0 ]; then
  if [ "$force" != true ]; then
    printf 'restore: the stack is not empty: it holds %s.\n' "$(printf '%s; ' "${held[@]}" | sed 's/; $//')" >&2
    echo "restore: pass --force to replace it with the backup." >&2
    exit 1
  fi
  echo "Replacing the stack's data (--force)"
  docker compose stop app
  sandboxes=$(docker ps --all --quiet --filter "label=jj.sandbox.namespace=$namespace")
  [ -z "$sandboxes" ] || xargs docker rm --force >/dev/null <<<"$sandboxes"
  [ -z "$volumes" ] || xargs docker volume rm >/dev/null <<<"$volumes"
  docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 --quiet --username="$POSTGRES_USER" --dbname=postgres -c "drop database if exists \"$POSTGRES_DB\" with (force)" -c "create database \"$POSTGRES_DB\""'
fi

echo "- database"
docker compose exec -T postgres sh -c 'exec pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-owner --no-acl --single-transaction --exit-on-error' <"$dir/database.dump"

# Workspaces get the driver's labels back, under this stack's namespace, so
# the docker driver mounts them for their tasks again.
restored=0
for archive in "$dir"/volumes/*.tar; do
  [ -e "$archive" ] || continue
  name=$(basename "$archive" .tar)
  volume=$namespace${name#"$source_namespace"}
  labels=()
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    case "$label" in
      jj.sandbox.namespace=*) label=jj.sandbox.namespace=$namespace ;;
    esac
    labels+=(--label "$label")
  done <"${archive%.tar}.labels"
  echo "- workspace $volume"
  docker volume create --driver local ${labels[@]+"${labels[@]}"} "$volume" >/dev/null
  docker run --rm --interactive --network none --read-only --user 0:0 --cap-drop ALL \
    --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges \
    --volume "$volume:/workspace" --entrypoint tar "$image" \
    --numeric-owner -C /workspace -xpf - <"$archive"
  restored=$((restored + 1))
done

echo
echo "Restore check"
status=0
check || status=$?
after=$(check --env) || true
same=true
for key in bots tasks artifacts artifact_bytes; do
  [ "$(sed -n "s/^$key=//p" <<<"$after")" = "$(backed "$key")" ] || same=false
done
if [ "$same" = true ]; then
  echo "Records match the backup's data check. Workspaces restored: $restored."
else
  echo "Records differ from the backup's data check (bots: $(backed bots), tasks: $(backed tasks), artifacts: $(backed artifacts)), which ran just before the dump: work the stack did meanwhile is in the dump only. Workspaces restored: $restored."
fi
[ "$status" -eq 0 ] || fail "this build cannot run the restored database; run the version the backup was made with ($(backed build_version), migration $(backed schema_latest)) or a later one."
echo "Start the stack: docker compose up -d --wait"
