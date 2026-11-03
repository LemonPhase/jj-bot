#!/usr/bin/env bash
# Back up the compose stack while it runs: the PostgreSQL database (bots,
# tasks, events, artifacts and settings; artifacts are stored in it), and the
# docker driver's task workspace volumes. See "Backup and restore" in
# docs/development.md.
#
#   scripts/backup.sh [DIR]
#
# DIR (default backups/<project>-<UTC time>) must not exist or be empty. It
# receives database.dump (pg_dump, custom format, one consistent snapshot),
# volumes/<volume>.tar with volumes/<volume>.labels (each workspace, copied by
# a throwaway container), check.json and check.env (the data check: versions,
# migration level, record counts), manifest.json and SHA256SUMS.
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
out=${1:-backups/$project-$started}
if [ -e "$out" ] && [ -n "$(ls -A "$out")" ]; then fail "$out exists and is not empty."; fi
docker image inspect "$image" >/dev/null 2>&1 || fail "the image $image is missing; build the stack (docker compose build) or set JJ_BACKUP_IMAGE."

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
# Ephemeral workspaces live only as long as their sandbox and are left out.
volumes=()
while IFS= read -r volume; do
  [ -n "$volume" ] || continue
  mode=$(docker volume inspect --format '{{index .Labels "jj.sandbox.workspace-mode"}}' "$volume")
  [ "$mode" != ephemeral ] || continue
  echo "- workspace $volume"
  docker volume inspect --format '{{range $key, $value := .Labels}}{{$key}}={{$value}}{{println}}{{end}}' "$volume" | sed '/^$/d' >"$out/volumes/$volume.labels"
  docker run --rm --network none --read-only --user 0:0 --cap-drop ALL \
    --cap-add DAC_READ_SEARCH --security-opt no-new-privileges \
    --volume "$volume:/workspace:ro" --entrypoint tar "$image" \
    --numeric-owner -C /workspace -cf - . >"$out/volumes/$volume.tar"
  volumes+=("$volume")
done < <(docker volume ls --quiet --filter "label=jj.sandbox=1" --filter "label=jj.sandbox.namespace=$namespace")

(cd "$out" && sha256 database.dump volumes/* >SHA256SUMS)

{
  printf '{\n  "format": "jj-bot-backup",\n  "version": 1,\n'
  printf '  "createdAt": %s,\n' "$(json_string "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
  printf '  "composeProject": %s,\n' "$(json_string "$project")"
  printf '  "dockerNamespace": %s,\n' "$(json_string "$namespace")"
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

echo "Backed up: schema $(field schema_state) at $(field schema_latest); bots: $(field bots), tasks: $(field tasks), artifacts: $(field artifacts), workspaces: ${#volumes[@]}."
echo "Keep JJ_SECRET_KEY apart from $out; restore with scripts/restore.sh $out"
