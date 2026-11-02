#!/usr/bin/env bash
# Drive the run's own headless browser with playwright-cli.
#
#   .agents/skills/verify-jj-bot/scripts/pw.sh <run-dir> open            # opens the app's URL
#   .agents/skills/verify-jj-bot/scripts/pw.sh <run-dir> <playwright-cli command> [args]
#
# The browser session is named after the run, so parallel runs never share a
# browser, and every command runs inside <run-dir>/evidence, so a relative
# --filename lands next to the other proof. `open` adds the bundled Chromium
# and the run's URL; a hash route can follow it (`open '#/settings'`).
set -uo pipefail

run=${1:?usage: pw.sh <run-dir> <command> [args]}
shift
command -v playwright-cli >/dev/null ||
  { echo "pw.sh: playwright-cli is missing: npm install -g @playwright/cli" >&2; exit 1; }
url=$(cat "$run/url") || exit 1
session="jjv-$(basename "$run")"
cd "$run/evidence" || exit 1

if [ "${1:-}" = open ]; then
  set -- open --browser=chromium "$url/${2:-}"
fi
# Drop the update banner, which otherwise wraps every reply.
playwright-cli -s="$session" "$@" 2>&1 | grep -v -E '^(╔|╚|║)|Update available|npm install -g @playwright'
exit "${PIPESTATUS[0]}"
