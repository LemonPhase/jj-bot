#!/usr/bin/env bash
# Stop a verification instance and remove its scratch state. Keeps evidence/.
#
#   .agents/skills/verify-jj-bot/scripts/stop.sh <run-dir>
#
# Kills only the process group launch.sh started, never by name.
set -uo pipefail

run=${1:?usage: stop.sh <run-dir>}
[ -f "$run/pid" ] || { echo "stop.sh: $run is not a launch.sh run dir" >&2; exit 1; }
pid=$(cat "$run/pid")

# The browser session named after this run, if the drive opened one.
playwright-cli -s="jjv-$(basename "$run")" close >/dev/null 2>&1 || true

# Kill only if the pid is still this run's server: after a reboot or a long
# gap the number can belong to an unrelated process group.
ours() { ps -o command= -p "$pid" 2>/dev/null | grep -qF -- "--jj-verify-run=$run/"; }
if ! kill -0 "$pid" 2>/dev/null; then
  echo "stop.sh: server already gone"
elif ! ours; then
  echo "stop.sh: pid $pid is no longer this run's server; not killing it"
else
  # SIGTERM lets the API hand running sessions back; it allows itself 20 s.
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid"
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && ours && { kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid"; }
fi

if [ "$(cat "$run/driver" 2>/dev/null)" = docker ]; then
  ns="jj-verify-$(basename "$run")"
  label="label=jj.sandbox.namespace=$ns"
  ids=$(docker ps -aq --filter "$label"); [ -n "$ids" ] && docker rm -f $ids >/dev/null
  ids=$(docker network ls -q --filter "$label"); [ -n "$ids" ] && docker network rm $ids >/dev/null
  ids=$(docker volume ls -q --filter "$label"); [ -n "$ids" ] && docker volume rm $ids >/dev/null
fi

cp "$run/server.log" "$run/evidence/server.log" 2>/dev/null
rm -rf "$run/data" "$run/sandbox"
echo "stopped; evidence kept in $run/evidence"
