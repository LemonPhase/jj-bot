#!/usr/bin/env bash
# Restore a backup made by scripts/backup.sh into the compose stack, then run
# the restore check. See "Backup, restore and upgrades" in docs/development.md.
#
#   scripts/restore.sh [--force] DIR
#
# DIR is relative to the current directory. Restoring a backup means trusting
# it: pg_restore runs its SQL as the database's superuser.
#
# Before it changes anything, it checks the backup: its checksums, which
# cover every file it reads; that every workspace archive is one the manifest
# lists, named and labelled as the docker driver names a task workspace, and
# that no volume of that name exists outside the stack's namespace; that the
# stack's pg_restore reads the dump; and that this build ships the migration
# the backup's database is at. It starts the postgres service, and refuses a
# stack that already holds data (a database JJ Bot has opened, a workspace
# volume in its namespace, or a running app) unless --force is given.
#
# --force then stops the app, removes the namespace's sandboxes and workspace
# volumes and recreates the database, so the backup replaces everything. It
# restores the database and the workspaces, under the target stack's docker
# namespace, and runs the restore check: the database's migration level
# against this build, its records against the backup's, and the stored
# secrets the configured JJ_SECRET_KEY cannot read. The app is left stopped:
# start it with `docker compose up -d --wait`.
#
# Exits 1 when the backup is damaged or refused, the stack refuses it, or the
# restore check fails.
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
dir=$(cd "$dir" 2>/dev/null && pwd) || fail "no backup directory $dir"

cd "$(dirname "$0")/.."
image=${JJ_BACKUP_IMAGE:-jj-sandbox:base-1}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# The backup's integrity: SHA256SUMS lists only the backup's own files, and
# at least the ones read here.
for file in manifest.json check.env database.dump SHA256SUMS; do
  [ -f "$dir/$file" ] || fail "$dir is not a JJ Bot backup: $file is missing."
done
if ! grep -q '"format": "jj-bot-backup"' "$dir/manifest.json" || ! grep -q '"version": 1,' "$dir/manifest.json"; then
  fail "$dir/manifest.json is not a version 1 JJ Bot backup manifest."
fi
echo "Checking $dir"
listed=$(awk '{ print $2 }' "$dir/SHA256SUMS")
while IFS= read -r file; do
  [[ $file =~ ^(manifest\.json|check\.env|check\.json|database\.dump|volumes/[A-Za-z0-9_.-]+\.(tar|labels))$ ]] ||
    fail "the backup is refused: SHA256SUMS lists $file, which is not a backup file."
done <<<"$listed"
for file in manifest.json check.env database.dump; do
  grep -qx "$file" <<<"$listed" || fail "the backup is refused: SHA256SUMS does not cover $file."
done
(cd "$dir" && sha256 -c --quiet SHA256SUMS) || fail "the backup is damaged: its checksums do not match."

backed() { sed -n "s/^$1=//p" "$dir/check.env"; }
source_namespace=$(sed -n 's/^  "dockerNamespace": "\(.*\)",$/\1/p' "$dir/manifest.json")
if ! [[ $source_namespace =~ ^[a-z0-9][a-z0-9_.-]{0,39}$ ]] || [ "$source_namespace" != "$(backed docker_namespace)" ]; then
  fail "the backup is refused: its manifest and its data check name different docker namespaces."
fi
commit=$(sed -n 's/^  "checkoutCommit": "\([0-9a-f]*\)",$/\1/p' "$dir/manifest.json")

# Workspaces: only those the manifest lists, each named and labelled as the
# docker driver names a task or bot workspace in the backup's namespace.
names=$(awk '/^  "volumes": \[/ { on = 1; if ($0 ~ /\]/) exit; next } on && /^  \]/ { exit } on { gsub(/[ ",]/, ""); print }' "$dir/manifest.json")
for archive in "$dir"/volumes/*.tar "$dir"/volumes/*.labels; do
  [ -e "$archive" ] || continue
  name=$(basename "$archive")
  grep -qxF "${name%.*}" <<<"$names" || fail "the backup is refused: volumes/$name is not a workspace its manifest lists."
done
workspaces=()
while IFS= read -r name; do
  [ -n "$name" ] || continue
  rest=${name#"$source_namespace-"}
  mode=${rest%%-*}
  key=${rest#*-}
  if [ "$rest" = "$name" ] || [[ $rest != *-* ]] || { [ "$mode" != task ] && [ "$mode" != bot ]; } ||
    ! [[ $key =~ ^[A-Za-z0-9_-]{1,128}$ ]]; then
    fail "the backup is refused: $name is not a workspace volume of the namespace $source_namespace."
  fi
  for file in "volumes/$name.tar" "volumes/$name.labels"; do
    grep -qx "$file" <<<"$listed" || fail "the backup is refused: SHA256SUMS does not cover $file."
  done
  expected=$(printf '%s\n' jj.sandbox=1 "jj.sandbox.namespace=$source_namespace" \
    "jj.sandbox.workspace-key=$key" "jj.sandbox.workspace-mode=$mode" | sort)
  [ "$(sed '/^$/d' "$dir/volumes/$name.labels" | sort)" = "$expected" ] ||
    fail "the backup is refused: the labels of $name are not the docker driver's."
  workspaces+=("$mode-$key")
done <<<"$names"

docker image inspect "$image" >/dev/null 2>&1 || fail "the image $image is missing; build the stack (docker compose build) or set JJ_BACKUP_IMAGE."
check() {
  docker compose run --rm --no-deps -T app node --import tsx apps/api/src/data-check.ts "$@"
}

docker compose up --detach --wait postgres
target=$(check --env) || [ -n "${target:-}" ] || fail "the data check could not read the stack's database (an app image without apps/api/src/data-check.ts needs \`docker compose build app\`)."
current() { sed -n "s/^$1=//p" <<<"$target"; }
namespace=$(current docker_namespace)
[[ $namespace =~ ^[a-z0-9][a-z0-9_.-]{0,39}$ ]] || fail "the data check named no docker namespace for this stack."

# This build must know the migration the backup's database is at: it never
# migrates backwards, and refuses to start on a newer schema.
tags=$(current build_migration_tags)
[ -n "$tags" ] || fail "this app image predates the restore check's migration list; rebuild it (docker compose build app)."
level=$(backed schema_latest)
if [ "$(backed schema_newer)" != 0 ] || [ -z "$level" ] || ! grep -qxF "$level" <<<"${tags//,/$'\n'}"; then
  fail "the backup's database is at migration ${level:-unknown to the build that made it} ($(backed schema_applied) applied), which this build does not ship (its newest is $(current build_latest_migration)); restore it with the version it was made with$([ -z "$commit" ] || echo " (checkout $commit)") or a later one. Nothing was changed."
fi

# This stack's pg_restore must read the dump (a newer PostgreSQL's dump may
# need a newer one).
if ! unreadable=$(docker compose exec -T postgres pg_restore --list 2>&1 >/dev/null <"$dir/database.dump"); then
  fail "this stack's pg_restore cannot read the backup's dump ($(tr '\n' ' ' <<<"$unreadable" | sed 's/ *$//')); restore it into a stack on the PostgreSQL version that made it ($(sed -n 's/^  "postgres": { "server": "\([^"]*\)".*/\1/p' "$dir/manifest.json")) or a later one. Nothing was changed."
fi

volumes=$(docker volume ls --quiet --filter "label=jj.sandbox=1" --filter "label=jj.sandbox.namespace=$namespace")
for workspace in ${workspaces[@]+"${workspaces[@]}"}; do
  volume=$namespace-$workspace
  if docker volume inspect "$volume" >/dev/null 2>&1 && ! grep -qxF "$volume" <<<"$volumes"; then
    fail "a volume named $volume exists outside the namespace $namespace's workspaces; the restore will not write into it. Nothing was changed."
  fi
done

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

# Workspaces get the driver's labels back, under this stack's namespace, in
# new volumes only, so the docker driver mounts them for their tasks again.
restored=0
for workspace in ${workspaces[@]+"${workspaces[@]}"}; do
  volume=$namespace-$workspace
  mode=${workspace%%-*}
  key=${workspace#*-}
  echo "- workspace $volume"
  ! docker volume inspect "$volume" >/dev/null 2>&1 || fail "the volume $volume already exists; the restore will not write into it."
  docker volume create --driver local --label jj.sandbox=1 --label "jj.sandbox.namespace=$namespace" \
    --label "jj.sandbox.workspace-mode=$mode" --label "jj.sandbox.workspace-key=$key" "$volume" >/dev/null
  docker run --rm --interactive --network none --read-only --user 0:0 --cap-drop ALL \
    --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --security-opt no-new-privileges \
    --volume "$volume:/workspace" --entrypoint tar "$image" \
    --numeric-owner -C /workspace -xpf - <"$dir/volumes/$source_namespace-$workspace.tar"
  restored=$((restored + 1))
done

echo
echo "Restore check"
status=0
check || status=$?
after=$(check --env 2>/dev/null) || true
state=$(sed -n 's/^schema_state=//p' <<<"$after")
if [ "$state" = newer ]; then
  fail "this build cannot run the restored database; run the version the backup was made with$([ -z "$commit" ] || echo " (checkout $commit)"), at migration $(backed schema_latest), or a later one."
fi
if [ "$status" -ne 0 ] || [ -z "$state" ]; then
  fail "the restore check could not read the restored database (see above)."
fi
same=true
for key in bots tasks artifacts artifact_bytes; do
  [ "$(sed -n "s/^$key=//p" <<<"$after")" = "$(backed "$key")" ] || same=false
done
if [ "$same" = true ]; then
  echo "Records match the backup's data check. Workspaces restored: $restored."
else
  echo "Records differ from the backup's data check (bots: $(backed bots), tasks: $(backed tasks), artifacts: $(backed artifacts)), which ran just before the dump: work the stack did meanwhile is in the dump only. Workspaces restored: $restored."
fi
echo "Start the stack: docker compose up -d --wait"
