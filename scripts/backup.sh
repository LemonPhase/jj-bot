#!/usr/bin/env bash
# Back up the compose stack while it runs: the PostgreSQL database (bots,
# tasks, events, artifacts and settings; artifacts are stored in it), and the
# docker driver's task workspace volumes. See "Backup and restore" in
# docs/development.md.
#
#   scripts/backup.sh [DIR]
#
# DIR (relative to the current directory; default backups/<project>-<UTC
# time> in the repository) must not exist or be empty. It receives
# database.dump (pg_dump, custom format, one consistent snapshot),
# volumes/<volume>.tar with volumes/<volume>.labels (each workspace, copied by
# a throwaway container), check.json and check.env (the data check: versions,
# migration level, record counts), manifest.json and SHA256SUMS, which covers
# every other file.
#
# The backup holds everything the database holds, the generated API token
# included: keep it as secret as the server. It never holds JJ_SECRET_KEY,
# which must be kept apart from it: without that key, stored secrets restore
# as unreadable.
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
  echo "backup: $*" >&2
  exit 1
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  -*) fail "unknown option $1 (see --help)" ;;
esac
[ $# -le 1 ] || fail "too many arguments (see --help)"

# A DIR given relative to where the script was called from, not the
# repository root it then works in.
out=${1:-}
case "$out" in
  "" | /*) ;;
  *) out=$PWD/$out ;;
esac

cd "$(dirname "$0")/.."
image=${JJ_BACKUP_IMAGE:-jj-sandbox:base-1}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}
json_string() {
  local value=${1//\\/\\\\}
  printf '"%s"' "${value//\"/\\\"}"
}

postgres=$(docker compose ps --status running --quiet postgres)
[ -n "$postgres" ] || fail "the stack's postgres service is not running; start the stack first (docker compose up -d --wait)."
project=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$postgres")
started=$(date -u +%Y%m%dT%H%M%SZ)
out=${out:-$PWD/backups/$project-$started}
if [ -e "$out" ] && [ -n "$(ls -A "$out")" ]; then fail "$out exists and is not empty."; fi
docker image inspect "$image" >/dev/null 2>&1 || fail "the image $image is missing; build the stack (docker compose build) or set JJ_BACKUP_IMAGE."
commit=$(git rev-parse --short=12 HEAD 2>/dev/null || true)

umask 077
mkdir -p "$out/volumes"
echo "Backing up the compose project $project into $out"

# The data check runs in the app image, with the app's settings, without
# migrating anything: this build's versions and the database's level.
check() {
  docker compose run --rm --no-deps -T app node --import tsx apps/api/src/data-check.ts "$@"
}
check --env >"$out/check.env" || fail "the data check failed (an app image without apps/api/src/data-check.ts needs \`docker compose build app\`)."
check --json >"$out/check.json"
field() { sed -n "s/^$1=//p" "$out/check.env"; }
namespace=$(field docker_namespace)
[ "$(field schema_state)" != empty ] || fail "the database is empty: there is nothing to back up."

# One snapshot of the whole database, consistent while the app writes.
echo "- database"
docker compose exec -T postgres sh -c 'exec pg_dump --format=custom --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"' >"$out/database.dump"
pg_dump_version=$(docker compose exec -T postgres pg_dump --version)
server_version=$(docker compose exec -T postgres sh -c 'psql -tA --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" -c "show server_version"')

# Each task workspace, read by a throwaway container that mounts it read-only.
# Ephemeral workspaces live only as long as their sandbox and are left out, as
# is a workspace that is gone by the time it is read (a sandbox released it).
volumes=()
skipped=0
gone() {
  echo "- workspace $1: gone before it was copied, skipped"
  rm -f "$out/volumes/$1.labels" "$out/volumes/$1.tar"
  skipped=$((skipped + 1))
}
while IFS= read -r volume; do
  [ -n "$volume" ] || continue
  if ! labels=$(docker volume inspect --format '{{range $key, $value := .Labels}}{{$key}}={{$value}}{{println}}{{end}}' "$volume" 2>/dev/null); then
    gone "$volume"
    continue
  fi
  if grep -qx 'jj.sandbox.workspace-mode=ephemeral' <<<"$labels"; then continue; fi
  echo "- workspace $volume"
  sed '/^$/d' <<<"$labels" >"$out/volumes/$volume.labels"
  if ! docker run --rm --network none --read-only --user 0:0 --cap-drop ALL \
    --cap-add DAC_READ_SEARCH --security-opt no-new-privileges \
    --volume "$volume:/workspace:ro" --entrypoint tar "$image" \
    --numeric-owner -C /workspace -cf - . >"$out/volumes/$volume.tar"; then
    docker volume inspect "$volume" >/dev/null 2>&1 || {
      gone "$volume"
      continue
    }
    fail "could not copy the workspace $volume."
  fi
  # `docker run` creates a volume that vanished just before it: that one is
  # empty and carries no driver labels. Remove it again.
  if [ "$(docker volume inspect --format '{{index .Labels "jj.sandbox"}}' "$volume" 2>/dev/null)" != 1 ]; then
    docker volume rm "$volume" >/dev/null 2>&1 || true
    gone "$volume"
    continue
  fi
  volumes+=("$volume")
done < <(docker volume ls --quiet --filter "label=jj.sandbox=1" --filter "label=jj.sandbox.namespace=$namespace")

{
  printf '{\n  "format": "jj-bot-backup",\n  "version": 1,\n'
  printf '  "createdAt": %s,\n' "$(json_string "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  printf '  "composeProject": %s,\n' "$(json_string "$project")"
  printf '  "dockerNamespace": %s,\n' "$(json_string "$namespace")"
  printf '  "checkoutCommit": %s,\n' "$(json_string "$commit")"
  printf '  "postgres": { "server": %s, "pgDump": %s },\n' \
    "$(json_string "$server_version")" "$(json_string "$pg_dump_version")"
  printf '  "secretKey": "not included: keep JJ_SECRET_KEY apart from this backup",\n'
  printf '  "volumes": ['
  separator=
  for volume in ${volumes[@]+"${volumes[@]}"}; do
    printf '%s\n    %s' "$separator" "$(json_string "$volume")"
    separator=,
  done
  printf '%s],\n' "${volumes[@]+$'\n  '}"
  printf '  "data": '
  sed '2,$s/^/  /' "$out/check.json"
  printf '}\n'
} >"$out/manifest.json"

# Every file the restore reads, listed explicitly (a backup may hold no
# workspace at all).
files=(manifest.json check.env check.json database.dump)
for volume in ${volumes[@]+"${volumes[@]}"}; do
  files+=("volumes/$volume.labels" "volumes/$volume.tar")
done
(cd "$out" && sha256 "${files[@]}" >SHA256SUMS)

echo "Backed up: schema $(field schema_state) at $(field schema_latest); bots: $(field bots), tasks: $(field tasks), artifacts: $(field artifacts), workspaces: ${#volumes[@]}$([ "$skipped" -eq 0 ] || echo " ($skipped gone meanwhile, skipped)")."
echo "Keep JJ_SECRET_KEY apart from $out; restore with scripts/restore.sh $out"
