#!/bin/sh
# `jj-auth` in the app image: the sign-in helpers of `npm run auth:*`, with the
# container's settings (DATABASE_URL, API_PUBLIC_URL, ...).
#
#   docker compose exec app jj-auth token           the access token, alone
#   docker compose exec app jj-auth login-link      a new one-time login link
#   docker compose exec -it app jj-auth hash-password
#
# `docker compose exec` runs as root, so this drops to the app user first.
set -eu
cd /app
if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid=jj --regid=jj --clear-groups --no-new-privs -- \
    env HOME=/nonexistent node --import tsx apps/api/src/auth-cli.ts "$@"
fi
exec node --import tsx apps/api/src/auth-cli.ts "$@"
