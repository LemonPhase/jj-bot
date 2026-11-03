#!/usr/bin/env bash
# Start an isolated JJ Bot instance for verification and print its run dir.
#
#   .agents/skills/verify-jj-bot/scripts/launch.sh [--no-build] [--driver local|docker] [--secret-store]
#
# One process serves the API, the embedded worker and the built web app on a
# free loopback port. It never reads the repository's .env: the environment is
# cleared, so provider keys, API_TOKEN and DATABASE_URL from your shell or .env
# never reach it. The only model is the keyless scripted test model.
# --secret-store gives the instance a fresh random JJ_SECRET_KEY, so keys and
# secrets can be stored in Settings; it is never written to disk.
# Data, sandbox workspaces and logs live in the run dir; stop.sh removes all of
# it except evidence/.
set -euo pipefail

repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
build=1
driver=local
secret_store=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-build) build=0 ;;
    --driver) driver=$2; shift ;;
    --secret-store) secret_store=1 ;;
    *) echo "launch.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
case "$driver" in local | docker) ;; *) echo "launch.sh: --driver is local or docker" >&2; exit 2 ;; esac

tmp=${TMPDIR:-/tmp}
root=${JJ_VERIFY_ROOT:-${tmp%/}/jj-verify}
id=$(date +%Y%m%d-%H%M%S)-$$
run="$root/$id"
mkdir -p "$run/data" "$run/sandbox" "$run/evidence"

if [ "$build" = 1 ]; then
  (cd "$repo" && npm run build -w @jj/web) >"$run/build.log" 2>&1 ||
    { echo "launch.sh: web build failed, see $run/build.log" >&2; exit 1; }
fi
[ -f "$repo/apps/web/dist/index.html" ] ||
  { echo "launch.sh: apps/web/dist is missing; run without --no-build" >&2; exit 1; }

# The docker driver reaps every container of its namespace that another worker
# started, so a verification instance gets a namespace of its own and never
# touches your dev stack's sandboxes.
# The daemon address passes through, so the instance and stop.sh's docker CLI
# talk to the same daemon (rootless, colima, a remote host).
docker_env=()
if [ "$driver" = docker ]; then
  docker_env=(JJ_DOCKER_NAMESPACE="jj-verify-$id")
  for var in DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH; do
    [ -n "${!var:-}" ] && docker_env+=("$var=${!var}")
  done
fi

# A master key for this run only, so the secrets store is on. Kept in the
# server's environment alone, like a real deployment's.
secret_env=()
if [ "$secret_store" = 1 ]; then
  secret_env=(JJ_SECRET_KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')")
fi

git -C "$repo" rev-parse HEAD >"$run/commit"
git -C "$repo" status --porcelain -- . ':!.agents' ':!.claude' >"$run/dirty"
echo "$driver" >"$run/driver"
echo "$secret_store" >"$run/secret-store"

cd "$repo"
# Job control gives the server a process group of its own (pgid = pid), so
# stop.sh can signal exactly that group; nohup keeps it alive when this shell
# exits. nohup and env exec, so $! is the node process. The trailing
# --jj-verify-run tag, which the API ignores, lets stop.sh confirm a pid
# still belongs to this run with plain ps on Linux and macOS alike.
set -m
nohup env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" NODE_ENV=production \
  API_HOST=127.0.0.1 API_PORT=0 \
  JJ_DATABASE_PATH="$run/data" \
  JJ_ENABLE_SCRIPTED_MODEL=true \
  JJ_SANDBOX_DRIVERS="$driver" JJ_SANDBOX_ROOT="$run/sandbox" \
  ${docker_env[@]+"${docker_env[@]}"} \
  ${secret_env[@]+"${secret_env[@]}"} \
  node --import tsx apps/api/src/index.ts "--jj-verify-run=$run/" >"$run/server.log" 2>&1 &
echo $! >"$run/pid"
set +m

# A launch that fails after the server started tears it down, so a failed
# attempt never strands a detached process; the run dir keeps the logs.
give_up() {
  echo "launch.sh: $1, see $run/server.log" >&2
  tail -20 "$run/server.log" >&2
  "$(dirname "$0")/stop.sh" "$run" >&2 || true
  exit 1
}

# Ready means the readiness checks pass (database, migrations, worker, drivers),
# not just that a port answers.
url=""
for _ in $(seq 1 120); do
  kill -0 "$(cat "$run/pid")" 2>/dev/null || give_up "server exited during startup"
  if [ -z "$url" ]; then
    url=$(grep -o -m1 'JJ Bot API at http://[0-9.:]*' "$run/server.log" | sed 's/^JJ Bot API at //' || true)
  fi
  if [ -n "$url" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' "$url/health/ready")" = 200 ]; then
    echo "$url" >"$run/url"
    echo "$run"
    exit 0
  fi
  sleep 0.5
done
give_up "not ready after 60 s (curl $url/health/ready names the failing check)"
