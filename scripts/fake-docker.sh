#!/usr/bin/env bash
# A stand-in for the docker CLI, for the tests of scripts/backup.sh and
# scripts/restore.sh (scripts/backup-restore.test.ts): it answers the
# commands those scripts run from a state directory ($FAKE_DOCKER_STATE) and
# logs every call. Not for any other use.
#
# State: log (every call), events (what changed), project, postgres_running,
# app_running, check.env (what the data check prints), check_fail (the data
# check cannot reach the database), after_restore.env and fail_after_restore
# (the data check after pg_restore), dump (what pg_dump prints),
# restored_dump, pg_restore_list_fail, volumes/<name>/{labels,data},
# vanish_on_inspect and vanish_on_run (volume names that disappear),
# volumes/<name>/users (containers using it) and server_version.
set -u
S=$FAKE_DOCKER_STATE
printf '%s\n' "$*" >>"$S/log"
last=${*: -1}
listed() { grep -qxF "$1" "$S/$2" 2>/dev/null; }

if [ "$1" = compose ]; then
  shift
  case "$1" in
    ps)
      [ ! -e "$S/${last}_running" ] || echo "id-$last"
      exit 0
      ;;
    up)
      touch "$S/postgres_running"
      exit 0
      ;;
    stop)
      rm -f "$S/app_running"
      echo "stopped app" >>"$S/events"
      exit 0
      ;;
    run)
      if [ -e "$S/check_fail" ]; then
        echo "connect ECONNREFUSED" >&2
        exit 1
      fi
      case "$last" in
        --env) cat "$S/check.env" ;;
        --json) echo '{ "fake": true }' ;;
        *) echo "Schema: $(sed -n 's/^schema_state=//p' "$S/check.env")" ;;
      esac
      if grep -qx 'schema_state=newer' "$S/check.env"; then exit 1; fi
      exit 0
      ;;
    exec)
      shift 3 # exec -T postgres
      case "$1" in
        pg_dump)
          echo "pg_dump (PostgreSQL) 17.0"
          exit 0
          ;;
        pg_restore)
          cat >/dev/null
          if [ -e "$S/pg_restore_list_fail" ]; then
            echo "pg_restore: error: unsupported version (1.99) in file header" >&2
            exit 1
          fi
          exit 0
          ;;
      esac
      case "$last" in
        *pg_dump*) cat "$S/dump" ;;
        *"show server_version"*) cat "$S/server_version" 2>/dev/null || echo 17.0 ;;
        *"drop database"*) echo "recreated the database" >>"$S/events" ;;
        *pg_restore*)
          cat >"$S/restored_dump"
          echo "restored the database" >>"$S/events"
          [ ! -e "$S/after_restore.env" ] || cp "$S/after_restore.env" "$S/check.env"
          [ ! -e "$S/fail_after_restore" ] || touch "$S/check_fail"
          ;;
      esac
      exit 0
      ;;
  esac
  exit 0
fi

case "$1" in
  inspect) cat "$S/project" ;;
  image) ;;
  ps)
    # Containers using a volume: volumes/<name>/users holds "<id> <namespace>".
    volume=$(printf '%s\n' "$@" | sed -n 's/^volume=//p')
    namespace=$(printf '%s\n' "$@" | sed -n 's/^label=jj.sandbox.namespace=//p')
    if [ -n "$volume" ] && [ -e "$S/volumes/$volume/users" ]; then
      while read -r id owner; do
        [ -z "$namespace" ] || [ "$owner" = "$namespace" ] || continue
        echo "$id"
      done <"$S/volumes/$volume/users"
    fi
    ;;
  rm) echo "removed containers ${*:3}" >>"$S/events" ;;
  volume)
    case "$2" in
      ls)
        namespace=$(printf '%s\n' "$@" | sed -n 's/^label=jj.sandbox.namespace=//p')
        for volume in "$S"/volumes/*/; do
          [ -d "$volume" ] || continue
          if grep -qx "jj.sandbox.namespace=$namespace" "$volume/labels" && grep -qx 'jj.sandbox=1' "$volume/labels"; then
            basename "$volume"
          fi
        done
        ;;
      inspect)
        if listed "$last" vanish_on_inspect; then rm -rf "$S/volumes/$last"; fi
        if [ ! -d "$S/volumes/$last" ]; then
          echo "Error response from daemon: get $last: no such volume" >&2
          exit 1
        fi
        format=
        [ "$3" != --format ] || format=$4
        case "$format" in
          *range*) sort "$S/volumes/$last/labels" && echo ;;
          *'"jj.sandbox"'*) sed -n 's/^jj\.sandbox=//p' "$S/volumes/$last/labels" ;;
          '') echo "[{\"Name\": \"$last\"}]" ;;
        esac
        ;;
      create)
        mkdir -p "$S/volumes/$last"
        if [ ! -e "$S/volumes/$last/labels" ]; then
          printf '%s\n' "${@:3}" | sed -n '/^--label$/{n;p;}' >"$S/volumes/$last/labels"
          echo "created volume $last" >>"$S/events"
        else
          echo "reused volume $last" >>"$S/events"
        fi
        echo "$last"
        ;;
      rm)
        for volume in "${@:3}"; do
          rm -rf "$S/volumes/$volume"
          echo "removed volume $volume" >>"$S/events"
        done
        ;;
    esac
    ;;
  run)
    volume=$(printf '%s\n' "$@" | sed -n 's#^\([^:]*\):/workspace.*#\1#p')
    if listed "$volume" vanish_on_run; then rm -rf "$S/volumes/$volume"; fi
    # Like docker, mounting a missing volume creates it, empty and unlabelled.
    [ -d "$S/volumes/$volume" ] || { mkdir -p "$S/volumes/$volume" && : >"$S/volumes/$volume/labels"; }
    if printf '%s\n' "$@" | grep -qx -- -cf; then cat "$S/volumes/$volume/data" 2>/dev/null; fi
    if printf '%s\n' "$@" | grep -qx -- -xpf; then
      cat >"$S/volumes/$volume/data"
      echo "wrote volume $volume" >>"$S/events"
    fi
    ;;
esac
exit 0
