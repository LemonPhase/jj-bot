#!/usr/bin/env bash
# Read-only check that a verification instance is worth driving.
#
#   .agents/skills/verify-jj-bot/scripts/doctor.sh <run-dir>
#
# Exits 0 only when every line says ok.
set -uo pipefail

run=${1:?usage: doctor.sh <run-dir>}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
fail=0
ok() { echo "ok    $*"; }
bad() { echo "FAIL  $*"; fail=1; }

pid=$(cat "$run/pid" 2>/dev/null) || { echo "FAIL  no pid in $run: not a launch.sh run dir"; exit 1; }
url=$(cat "$run/url" 2>/dev/null) || { echo "FAIL  no url in $run: launch never got ready"; exit 1; }
port=${url##*:}

kill -0 "$pid" 2>/dev/null && ok "process $pid is running" || bad "process $pid is gone; see $run/server.log"

# The port must belong to the process we started, not some other server.
owner=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
[ "$owner" = "$pid" ] && ok "port $port is owned by pid $pid" || bad "port $port is owned by '${owner:-nobody}', not $pid"

ready=$(curl -s "$url/health/ready")
[ "$(curl -s -o /dev/null -w '%{http_code}' "$url/health/ready")" = 200 ] && ok "ready: $ready" || bad "not ready: $ready"

boot=$(curl -s "$url/api/bootstrap")
node -e '
  const b = JSON.parse(process.argv[1]);
  const lines = [
    [b.mode === "backend", `mode ${b.mode}`],
    [b.capabilities?.agentExecution === true, `agentExecution ${b.capabilities?.agentExecution}`],
    [true, `contract ${b.contractVersion ?? b.contract ?? "?"}, ${b.bots?.length ?? "?"} bots, ${b.tasks?.length ?? "?"} tasks`],
  ];
  let failed = false;
  for (const [pass, text] of lines) {
    console.log(`${pass ? "ok  " : "FAIL"}  bootstrap ${text}`);
    if (!pass) failed = true;
  }
  process.exit(failed ? 1 : 0);
' "$boot" || fail=1

head=$(git -C "$repo" rev-parse HEAD)
built=$(cat "$run/commit")
[ "$head" = "$built" ] && ok "running commit $built (HEAD)" || bad "running commit $built but HEAD is $head: relaunch to verify HEAD"
if [ -s "$run/dirty" ]; then echo "note  launched from a dirty tree ($(wc -l <"$run/dirty") paths); uncommitted edits made after launch are not running"; fi

grep -q 'web served' "$run/server.log" && ok "web app served" || bad "web app not served: build apps/web first"
exit $fail
