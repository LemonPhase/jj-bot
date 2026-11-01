# Milestone 1 acceptance run — evidence

Run for issue #25 on `main` at `9978d78`, 2026-11-01 03:24–03:52 UTC. All bots ran on a real model (`openai/gpt-6-luna`). Every step went through the web UI, driven by Playwright (`chromium`). The API was used only to read state and collect evidence. Screenshots are in `screenshots/`, event logs and analyses in `logs/`, and files downloaded through the UI's Download buttons in `artifacts/`. The login token is redacted everywhere, and the evidence holds no model key (checked by grepping for the key value, `sk-…` and the token).

## Criteria

| # | Criterion (docs/milestone-1.md) | Result | Evidence | Notes |
|---|---|---|---|---|
| 1 | One compose command, no hosted dependency besides the model provider | **PASS** | `logs/compose-up.log`, `logs/app-boot.log` | `docker compose up -d --build --wait` brought postgres, sandbox-image and app to healthy in 50 s. Needed environment-only overrides; see Environment. |
| 2 | Bots persist identity, instructions, model, runtime profile and scoped memory across tasks | **PASS** | `13-studio-*`, `14-lead-memory-saved`, `logs/bots-after-restart.json` | After `docker compose restart app`, all 3 bots kept name, role, instructions, `openai/gpt-6-luna`, the default profile (`runtimeProfileId: null`) and unchanged `updatedAt`. Lead's memory "Prefer node:test; keep files small" persisted. The bots were reused across 7 tasks. The memory→prompt path was checked in code (`worker/prompts.ts`), not observed in events. |
| 3 | Runtime profiles created and edited in Settings and select a driver; both `local` and `docker` work | **PASS** | `02`–`10-profile*`, `80`–`84-local-*`, `logs/local-task-*.json` | Docker default was edited to network `none` and saved. A second profile was created, edited (description) and deleted. Separately, a PGlite server with `JJ_SANDBOX_DRIVERS=local` (`logs/local-api-boot.log`) got a "QA local" profile labelled **Unisolated**, and a one-bot task on it completed (`hello from local`). |
| 4 | Task creation records goal, coordinator and participants | **PASS** | `20-demo-new-task-dialog`, `logs/demo-view.json` | The New task dialog shows goal, coordinator Lead and participants Lead/Builder/Tester; `task.created` records all three. |
| 5 | ≥2 bots do real work in separate sessions, in parallel, inside sandboxes | **PASS** | `22-demo-live-00` ("IN PARALLEL", Builder and Tester working), `logs/demo-events.json` | Builder and Tester sessions overlapped, interleaving `write`/`bash` events (e.g. seq 60–330), each in its own session inside the docker sandbox with network `none`. |
| 6 | Sessions share files through the task workspace | **PASS** | `logs/demo-events.json` | Tester ran `node --test` against Builder's `wordfreq.js`. Lead `read` the files the workers wrote. Tester noted the shared `wordfreq.test.js` had been "updated by another teammate". |
| 7 | Messages attributed and visible to all, without activating every bot | **PASS** | `22-demo-live-00`, `logs/visibility-analysis.txt` | Every message carries author, intent and recipients, in one shared chat. Demo: 13 bot-to-bot `message` calls and 0 extra sessions; worker sessions created = successful `delegate` calls (7/7, 5/5, 5/5 across demo, steer and restart). The only `wake` runs came from delegated results returning to the delegating session, the designed path. |
| 8 | Coordinator delegates bounded work and receives results back | **PASS** | `23-demo-final-graph`, `logs/demo-events.json` | Lead delegated `wordfreq.js` to Builder and tests to Tester, received `result` messages, re-delegated corrections (N=0 mismatch), ran `node --test` and called `complete_task`. |
| 9 | Live activity per working bot; graph shows bots, assignments, commands and results | **PASS** | `22-demo-live-00`, `23-demo-final-graph`, `52-restart-reload-graph` | Activity lines ("Thinking…", "Waiting on delegated work", `write(wordfreq.test.js) → bash(node --test…)`). The graph shows session nodes per bot with briefs, tool counts, results and a tool trail. Minor UX: with 7 child sessions the coordinator node is clipped at 1440 px wide. |
| 10 | Steering reaches the coordinator and changes subsequent execution | **PASS** | `30-steer-*`, `31-steer-*`, `logs/steer-events.json`, `logs/steer-local-node-test.log` | Steering posted at seq 16. Lead immediately messaged Builder and Tester about `--min-length` (seq 37, 46), and every later delegation includes it (seq 59, 97, 113). The downloaded result passes 7/7 tests locally, and `--min-length 4` filters correctly. |
| 11 | Stop cancels active sessions, prevents new launches and records what stopped | **PASS** | `40-stop-*`, `41-stop-cmd-*`, `logs/stop-events.json`, `logs/stop-cmd-events.json` | Run A (`40`): running→cancel requested→`cancelled` in under 1 s; 3 sessions stopped, 3 queued `neverStarted`; Lead's in-flight `delegate` was aborted (`ok:false`); nothing launched after `cancellation.requested`. Run B (`41`, two `sleep 120` commands in flight): the API showed the stopping state (cancel requested, one session still running), then `cancelled`. `cancellation.completed` lists both commands `interrupted: "yes"` (exit 143), and no session or run started after the request. The UI shows "Stop requested" then "Task stopped"; the stopping window was too short for a screenshot to catch the "Stopping…" pill. |
| 12 | Files a session produces are downloadable as artifacts | **PASS (with deviation)** | `23-demo-final-artifacts`, `artifacts/23-demo-final/`, `logs/demo-local-node-test.log` | All artifacts downloaded through the UI. `wordfreq.js`, `wordfreq.test.js`, `README.md` and `package.json` passed 6/6 tests locally (node 22, `--network none` container). **Deviation from the demo's expected run:** in the demo instance Tester used temp files and wrote no `sample.txt`. The steer and restart instances did produce `sample.txt`. Each file version is listed as a separate artifact, so the latest of each must be chosen. |
| 13 | After a server restart, in-flight work resumes or fails visibly; completed work never silently repeated | **PASS** | `50`–`52-restart-*`, `logs/restart-events.json`, `logs/restart-analysis.txt`, `logs/app-full.log` | `docker compose restart app` ran with 3 sessions live. Four runs ended "The worker stopped; the session resumes from its last completed turn" and restarted with `reason: "recovery"`. 85 tool calls, all unique `toolCallId`s; none of the 10 completed before the restart started again; nothing left unfinished. Lead then ended its turn without `complete_task`, so the task sat `waiting` (the documented state, visible in the UI). One user message continued it, and it completed with a consolidated result. |
| 14 | Reload or reconnect reconstructs activity without re-running anything | **PASS** | `24-demo-reload-*`, `52-restart-reload-*` | Browser reload of the demo and restart tasks rebuilt chat, progress, graph and results. The event count was 459 before and after the reload. |
| 15 | With `docker`, agent code cannot read model keys, host files or host env; `local` labelled unisolated | **PASS** | `logs/isolation-events.json`, `logs/isolation-analysis.txt`, `81-local-profiles`, `82-local-bot-form` | In the sandbox, `env` and `/proc/1/environ` show only PATH, HOSTNAME, HOME, NODE_VERSION, YARN_VERSION and `JJ_SANDBOX_EXEC`. `ls /` is the image root, uid 1000, no `/var/run/docker.sock`, `/root` denied, `/etc/hostname` empty. Searching the event log finds 0 hits for "OPENAI", "sk-", the key value, DATABASE_URL, HTTPS_PROXY and docker.sock. The UI labels local profiles "Unisolated". |
| 16 | A third bot routes through the same paths, no two-bot special case | **PASS** | `23-demo-final-graph`, `logs/demo-events.json` | Lead, Builder and Tester all ran through `delegate` → `session.created` → `run.started` → `message`/`result`. Builder also delegated to Lead as a worker (depth 2) through the same path. |

Additional checks requested in the run plan:

- **Settings › Models** shows OpenAI configured (`01-settings`).
- **Direct chat** (`70-chat-0`, `71-chat-*`, `logs/chat-lead-messages.json`, `logs/chat-task-*.json`): "hi" got a plain reply and created no task (6 tasks → 6). A work request created exactly one task (6 → 7), linked from the reply. A follow-up was routed into that task (7 → 7): Lead forwarded "append beta", and the task ended with `notes.txt` = `alpha\nbeta`.

## Failures and observations

- **No criterion failed.**
- Demo deviation: no `sample.txt` artifact in the first demo instance (see #12).
- Restart instance: the luna coordinator ended its turn without `complete_task`, so the task sat in `waiting` until a user message. This is documented behaviour, but in an unattended run it looks like a hang. It is a model-quality issue (cheap model), not a lost-work issue.
- With gpt-6-luna, Lead over-delegated: duplicate Builder and Tester sessions, and several bots wrote the same `wordfreq.test.js`. Ownership rules were stated but not always followed. A retry on `gpt-6-sol` was not needed because coordination succeeded.
- UX: the graph clips the coordinator node when there are many children (#9). "Stopping…" is very brief, since docker stops are fast.

## Environment

- Cloud container (root), Docker 5.6 Compose plugin, `dockerd` with `registry-mirrors: ["https://mirror.gcr.io"]`. Host Node 22.23.4.
- **Sandbox image was a fallback.** Debian apt mirrors are blocked here, so `jj-sandbox:base-1` was built from an inline Dockerfile: `FROM node:22-bookworm-slim`, the node user renamed to uid 1000 `sandbox`, and `/workspace` owned by it. It has no git, python3, ripgrep or curl. CI builds the real apt-based image. The demo needs only node.
- Uncommitted `compose.override.yaml` (copy: `compose.override.used.yaml`): the `build_ca` build secret with the proxy CA plus an `HTTPS_PROXY` build arg for the app image (built with `BUILDX_BAKE_ENTITLEMENTS_FS=0`, per docs/development.md); `NODE_EXTRA_CA_CERTS` and a read-only CA mount for the app at runtime; the fallback sandbox image. The product code was unmodified.
- The host's egress proxy listens on host loopback, so a small TCP relay on the docker bridge (`172.17.0.1:3128`) forwarded to it. The app used `HTTPS_PROXY=http://host.docker.internal:3128` (as docs/development.md describes).
- `.env`: from `.env.example`, with `JJ_DEFAULT_MODEL=openai/gpt-6-luna`; `OPENAI_API_KEY` passed through from the environment.
- Local driver run: `npm ci`, `npm run build -w @jj/web`, `npm run start -w @jj/api` with `JJ_SANDBOX_DRIVERS=local`, `API_PORT=3002` and a PGlite path, outside compose.

## Models and cost

All sessions and chat replies ran on `openai/gpt-6-luna`; `gpt-6-sol` was never used. Costs are from the product's usage records, which price by the catalogue:

| Scope | Model calls | Cost (USD) |
|---|---|---|
| Demo task | 88 | 0.0147 |
| Steering task | 80 | 0.0126 |
| Stop task A / B | 11 / 7 | 0.0011 / 0.0008 |
| Restart task | 95 | 0.0183 |
| Isolation task | 2 | 0.0005 |
| Chat-created task | 4 | 0.0003 |
| Direct chat replies (3) | 3 | 0.0004 |
| Local-driver task | — | 0.0003 |
| **Total** | | **≈ $0.049** |
