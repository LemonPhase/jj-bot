# @jj/runtime

The pi agent runtime (`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, pinned at 1.4.0). No database access: the engine supplies inputs and persists what the hooks hand it.

- `ModelRegistry` wraps pi-ai's catalog for the offered providers (each enabled by one API-key variable). `providers()` and `view()` feed `GET /api/models`; `defaultModel()` honours `JJ_DEFAULT_MODEL` when its provider is configured; `resolve(ref | null)` returns the pi model and a key getter. Keys come only from the env the registry was built with and are handed to pi per call. pi's own auth resolution is pointed at that env and never at host credential files.
- `PiSessionExecutor.run(input)` runs one execution session on pi's low-level agent loop over a transcript the engine owns: no pi session files, settings, context files or extensions are loaded.
- `ChatResponder.reply(input)` answers a direct message with the bot's model and the engine's chat tools, at most six model calls, no sandbox.
- `repairTranscript` answers tool calls left without a result by a crash as interrupted with an unknown outcome; nothing is re-run. `serializeEntry` and `parseTranscript` store and load entries (`TRANSCRIPT_FORMAT`), refusing shapes they do not recognise.
- The scripted test model (`scripted/team`, "Scripted test model") is registered only with `enableScripted`. It is rule-based on the conversation and reads rosters and active tasks in the formats of `formatRoster` and `formatActiveTasks`, which the engine uses to build prompts.

## Tools and the sandbox

Every coding tool acts through the run's `Sandbox`. `read`, `edit`, `write`, `ls` and `find` are pi's tools on sandbox-backed operations, with paths resolved inside the workspace before pi sees them. `bash` and `grep` are JJ tools over `sandbox.exec`: pi's bash passes the host environment to its operations and writes truncated output to host temp files, and pi's grep always spawns a host ripgrep. Tool output over the cap (`JJ_OUTPUT_CAP_BYTES`, at most 64 KiB) is spilled whole through `spillOutput`; the model and the event see its head and tail and the artifact id.

## Run semantics

- Persistence: `onTurnComplete(entries)` receives the run's inputs and injected steering before the model call that sees them, an assistant message that calls tools before those tools run, and each turn's results when it completes. System messages are never persisted; the prompt is rebuilt every run. Aborted or failed model responses are not persisted.
- Steering: `drainInbox()` is polled before the first model call and at every turn boundary; texts are injected as user messages through pi's steering hook.
- Budgets: `maxTurns` counts model calls in the run; the deadline aborts what is in flight. Either ends the run with `budget` when the model still wanted to continue.
- Abort: the signal cancels the model call and the running sandbox command; the command reports `interrupted` and the outcome is `aborted`.
- A collaboration tool returning `endRun` (complete_task) ends the run after its tool batch.

Tests use pi's faux provider, the scripted model and the `local` sandbox driver; none call a live model. `npm run smoke:runtime` runs one live tool cycle with `JJ_SMOKE_MODEL` (default `openai/gpt-6-luna`).

`src/legacy` holds the Gemini-era `GeminiSessionExecutor` and `GeminiBotRouter`, re-exported unchanged for the old backend until the engine rewrite removes them.
