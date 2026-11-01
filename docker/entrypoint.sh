#!/bin/sh
# Entrypoint of the app image. The docker sandbox driver reaches the host's
# Docker daemon through the mounted socket, whose group id differs per host,
# so this joins the app user to the socket's group and then drops root for
# good: the app never runs as root.
set -eu

APP_USER=jj

if [ "$(id -u)" != 0 ]; then
  # Started as another user (--user): run as that user. The socket's group
  # must then be added by the operator (compose `group_add`).
  exec "$@"
fi

case "${DOCKER_HOST:-}" in
  "") socket=/var/run/docker.sock ;;
  unix://*) socket=${DOCKER_HOST#unix://} ;;
  *) socket= ;; # tcp:// (a socket proxy): no socket to join.
esac

groups=$(id -g "$APP_USER")
if [ -n "$socket" ]; then
  if [ -S "$socket" ]; then
    # -L: the socket itself, when the path is a symlink to it.
    gid=$(stat -L -c %g "$socket")
    candidate=$groups
    [ "$gid" = "$groups" ] || candidate="$groups,$gid"
    # Join the socket's group only when that actually grants access.
    # shellcheck disable=SC2016 # $1 expands in the inner shell.
    if setpriv --reuid="$APP_USER" --regid="$APP_USER" --groups="$candidate" \
      -- sh -c 'test -r "$1" && test -w "$1"' sh "$socket"; then
      groups=$candidate
    else
      echo "jj-entrypoint: $socket ($(stat -L -c '%U:%G %A' "$socket")) is not readable and writable by its group, so the app cannot use it and the docker sandbox driver will report unavailable. See \"Docker Compose\" in docs/development.md." >&2
    fi
  else
    echo "jj-entrypoint: no Docker socket at $socket, so the docker sandbox driver will report unavailable. Mount the host's socket there (compose.yaml does)." >&2
  fi
fi

# The app user has no home; HOME would otherwise still name root's.
export HOME=/nonexistent
# With CAP_SETPCAP (plain `docker run`), empty the bounding set too; compose
# drops every capability but SETUID, SETGID and KILL from it already.
bounding=
capeff=$(sed -n 's/^CapEff:[[:space:]]*//p' /proc/self/status)
if [ $((0x$capeff >> 8 & 1)) = 1 ]; then bounding=--bounding-set=-all; fi
# shellcheck disable=SC2086 # $bounding is one flag or nothing.
exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --groups="$groups" \
  --inh-caps=-all $bounding --no-new-privs -- "$@"
