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
    gid=$(stat -c %g "$socket")
    [ "$gid" = "$groups" ] || groups="$groups,$gid"
    # shellcheck disable=SC2016 # $1 expands in the inner shell.
    if ! setpriv --reuid="$APP_USER" --regid="$APP_USER" --groups="$groups" \
      -- sh -c 'test -r "$1" && test -w "$1"' sh "$socket"; then
      echo "jj-entrypoint: $socket ($(stat -c '%U:%G %A' "$socket")) is not readable and writable by its group, so the app cannot use it and the docker sandbox driver will report unavailable. Put a Docker socket proxy in front of it and set DOCKER_HOST." >&2
    fi
  else
    echo "jj-entrypoint: no Docker socket at $socket, so the docker sandbox driver will report unavailable. Mount the host's socket there (compose.yaml does)." >&2
  fi
fi

# The app user has no home; HOME would otherwise still name root's.
export HOME=/nonexistent
exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --groups="$groups" \
  --inh-caps=-all --no-new-privs -- "$@"
