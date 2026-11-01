#!/bin/sh
# HEALTHCHECK of the app image: healthy while GET /health/ready answers 200.
# Docker runs it as the image's user (root), so it drops to jj first.
set -eu
# shellcheck disable=SC2016 # JavaScript, not shell.
probe='fetch(`http://127.0.0.1:${process.env.API_PORT || 3001}/health/ready`, { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))'
if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid=jj --regid=jj --clear-groups --no-new-privs -- node -e "$probe"
fi
exec node -e "$probe"
