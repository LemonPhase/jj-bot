---

name: verify-jj-bot
description: Launch an isolated JJ Bot instance (API, embedded worker and built web app on PGlite, scripted model) and drive the web UI in a headless browser to prove a change works the way a user sees it. Use when a change touches the web app, the API, the engine or the worker and you need evidence beyond unit tests, or when asked to verify, demo or reproduce behavior in the running product.
---

# Verify JJ Bot

Drive the real product the way a user does: launch your own instance, check it with doctor, drive the web UI with `playwright-cli`, read the API for side effects, keep the evidence, then clean up. The feature recipes are in [features/README.md](features/README.md). Read the matching feature file before driving.

This complements, never replaces, `npm run verify` (lint, typecheck, tests, build) and `npm run smoke:e2e` (the whole server over HTTP, no browser). Use those for the gate; use this skill for what a user sees.

Every command below runs from the repository root. `$RUN` is the run dir that `launch.sh` prints.

## Prerequisites

- Linux or WSL: the helpers use `setsid`, `ss` and `/proc`, and `launch.sh` refuses other systems.
- `npm ci` has run in this checkout.
- `playwright-cli` is on `PATH` (`npm install -g @playwright/cli`) with Playwright's bundled Chromium installed (`playwright-cli install-browser chromium` or `npx playwright install chromium`). `pw.sh` always opens `--browser=chromium`; the default `chrome` channel is usually missing on Linux and WSL.
- `ss` and `curl` (doctor uses them).
- Docker only for `--driver docker`. The daemon is found through `DOCKER_HOST` (and `DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`), which `launch.sh` passes through; a daemon reached only through a `docker context` needs `DOCKER_HOST` set to that context's address.

## Launch

```sh
RUN=$(.agents/skills/verify-jj-bot/scripts/launch.sh)            # builds apps/web, local driver
RUN=$(.agents/skills/verify-jj-bot/scripts/launch.sh --no-build) # reuse apps/web/dist
RUN=$(.agents/skills/verify-jj-bot/scripts/launch.sh --driver docker)
```

It builds the web app (a few seconds), then starts one process, `node --import tsx apps/api/src/index.ts`, serving the API, the embedded worker and `apps/web/dist` on a free loopback port. It prints `$RUN` (`/tmp/jj-verify/<id>`, or under `$JJ_VERIFY_ROOT`) once `/health/ready` answers 200: database open, migrations applied, worker polling, a driver available. The URL is in `$RUN/url` and the server log in `$RUN/server.log`. When startup fails, or readiness doesn't pass within 60 s, it prints the run dir and the log tail on stderr, stops the server itself and exits 1, so a failed launch leaves no process behind.

Isolation, by construction:

- The environment is cleared (`env -i`), and the repository's `.env` is never read. Provider keys, `API_TOKEN` and `DATABASE_URL` never reach the instance. The only model is the keyless scripted test model (`scripted/team`), and the UI badge reads "Scripted model".
- Data is a fresh PGlite dir at `$RUN/data`. The workspace starts empty: no bots, no tasks, one default runtime profile.
- Sandbox workspaces are under `$RUN/sandbox`. `--driver docker` uses the namespace `jj-verify-<id>`, because a docker worker reaps every container of its own namespace that another process started, and a shared namespace would destroy your dev stack's sandboxes. The docker driver also needs the base image (`npm run sandbox:image`).
- Several runs can live side by side: separate ports, data dirs, namespaces and browser sessions. Never drive an instance this run didn't start, such as `npm run dev` on 5173/3001.

The instance runs the code that was on disk at launch. After editing code, stop and relaunch; doctor flags a HEAD that moved since launch.

## Doctor

```sh
.agents/skills/verify-jj-bot/scripts/doctor.sh "$RUN"
```

Read-only. It exits 0 only when every line says `ok`: the process is alive, the port is owned by that process, readiness is 200, bootstrap reports `mode backend` with `agentExecution true`, the running commit is HEAD, and the web app is served. A `note` line about a dirty tree means uncommitted changes were running at launch. Run doctor first, and again whenever anything looks off.

## Drive

```sh
P=.agents/skills/verify-jj-bot/scripts/pw.sh
$P "$RUN" open '#/studio'                     # headless Chromium at the run's URL
$P "$RUN" snapshot --filename=studio.yml      # ARIA tree with refs; read it before acting
$P "$RUN" fill "getByRole('textbox', { name: 'Name' })" "Nova"
$P "$RUN" click "getByRole('button', { name: 'Create bot' })"
$P "$RUN" press Enter
$P "$RUN" goto "$(cat "$RUN/url")/#/settings"
$P "$RUN" screenshot --filename=02-settings.png
```

`pw.sh` wraps `playwright-cli` with a browser session named after the run (`jjv-<id>`) and runs it inside `$RUN/evidence`, so relative `--filename` paths land with the rest of the proof. `playwright-cli` also writes an unnamed snapshot of every step to `$RUN/evidence/.playwright-cli/`; that's a step trail, not the proof, so cite your own named files.

- Target elements with Playwright role locators (`getByRole('button', { name: 'Start task' })`), never snapshot refs (`e42`) in a recipe: refs change on every render. The UI is labelled throughout: dialogs, tabs, logs, radiogroups and form fields all have accessible names.
- Screens are hash routes: `#/bots/:botId`, `#/tasks/:taskId`, `#/studio` (new bot), `#/studio/:botId`, `#/settings`. A list route without an id opens the first item.
- Snapshots taken right after navigation can show `Loading workspace…`. Snapshot again, or wait for the expected element, before reading it.
- `?demo` forces the built-in demo data. Never verify in demo mode; doctor's `mode backend` and the "Scripted model" badge prove you aren't in it.

Check side effects through the API with plain `curl`. Every `/api/*` answer is JSON and needs no token on this loopback instance:

```sh
U=$(cat "$RUN/url")
curl -s "$U/api/bots"
curl -s "$U/api/tasks"
curl -s "$U/api/tasks/<taskId>"                 # { task, sessions, messages, artifacts, events, ... }
curl -s "$U/api/tasks/<taskId>/artifacts/<artifactId>/content"
```

The scripted model is deterministic. A task goal that quotes a command after "run", such as ``run `echo hi > out.txt` ``, makes the worker run it, so a goal can produce a known file, a slow step (``run `sleep 60` ``) or a failure. A real model is out of scope here; `npm run smoke:runtime` covers live models.

## Evidence

Everything goes in `$RUN/evidence/`, which cleanup keeps. A proof:

- Drives the real user path in the browser. Creating state through `curl` POSTs proves the API, not the feature; use the API only for preconditions the feature under test doesn't own, and say so.
- Captures the action and the result: an ARIA snapshot (`snapshot --filename=<step>.yml`) before and after, plus a screenshot (`screenshot --filename=<nn>-<step>.png`) where the look matters.
- Confirms the side effect from a second view: the stored row through `curl /api/...`, the downloaded artifact bytes, the file in `$RUN/sandbox` (local driver) or a process that is gone after a stop. Save that output in the evidence dir too.
- States what wasn't covered. One entry point verified is not the feature verified when its file lists others.

Report the evidence path and the commit from `$RUN/commit`.

## Cleanup

```sh
.agents/skills/verify-jj-bot/scripts/stop.sh "$RUN"
```

It closes the run's browser session, sends SIGTERM to the process group `launch.sh` started (the API hands running sessions back within 20 s), SIGKILLs only that group if it lingers, removes the run namespace's docker containers, networks and volumes, copies `server.log` into `evidence/` and deletes `$RUN/data` and `$RUN/sandbox`. It never kills by process name. `$RUN/evidence` survives; delete it yourself once the proof is reported. Run cleanup after every failed attempt too, so no instance or port is stranded.

## Helpers

| Script                                                        | Use                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------- |
| `scripts/launch.sh [--no-build] [--driver local\|docker]`     | Start an isolated instance; prints `$RUN` when ready  |
| `scripts/doctor.sh <run>`                                     | Read-only health check; exit 0 when worth driving     |
| `scripts/pw.sh <run> open [hash] \| <playwright-cli command>` | Drive the run's browser session from its evidence dir |
| `scripts/stop.sh <run>`                                       | Tear down; keep evidence                              |
