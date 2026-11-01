# @jj/runtime

The pi agent runtime (`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`, pinned at 1.4.0). No database access: the engine supplies inputs and persists what the hooks hand it.

- `ModelRegistry` wraps pi-ai's catalog for the offered providers (each enabled by one API-key variable). `providers()` and `view()` feed `GET /api/models`; `defaultModel()` honours `JJ_DEFAULT_MODEL` when its provider is configured; `resolve(ref | null)` returns the pi model and a key getter. Keys come only from the env the registry was built with and are handed to pi per call. pi's own auth resolution is pointed at that env and never at host credential files.
- `PiSessionExecutor.run(input)` runs one execution session on pi's low-level agent loop over a transcript the engine owns: no pi session files, settings, context files or extensions are loaded.
- `ChatResponder.reply(input)` answers a direct message with the bot's model and the engine's chat tools, at most six model calls, no sandbox.
- `repairTranscript` answers tool calls left without a result by a crash as interrupted with an unknown outcome (nothing is re-run) and puts each call's results back in call order. `serializeEntry` and `parseTranscript` store and load entries (`TRANSCRIPT_FORMAT`), refusing shapes they do not recognise.
- The scripted test model (`scripted/team`, "Scripted test model") is registered only with `enableScripted`. It is rule-based on the conversation and ignores the free-form system prompt; it reads everything from the tools it is offered and from the engine's result headers. Its role: `create_task`/`send_to_task` mean chat, `complete_task` means coordinator, anything else worker. Whom it delegates to: the enum of `delegate`'s `bot` (the engine omits `delegate` when there is nobody). Active tasks: the enum of `send_to_task`'s `taskId`, with titles in its description as `id: title`. Bots a chat task can include: the item enum of `create_task`'s `participants`. A worker writes the notes file its brief names, then runs once each, with bash, every command its brief quotes after "run" (as in run `sleep 300`), so a goal can give a run a slow or failing step deterministically. A coordinator credits a delegate's outcome only by the first line the engine puts on it, exactly `Result from <bot> (session <id>):` or `Failure from <bot> (session <id>):`; any other message is steering.

## Tools and the sandbox

Every coding tool acts through the run's `Sandbox`, with paths resolved lexically inside the workspace (no `~` expansion, no host filesystem access).

- `read`, `edit` and `write` call `sandbox.fs` directly. pi's versions resolve the agent's path on the host first (read probes name variants with `access()`, edit and write take a `realpath()` lock key), so a host file at the same absolute path could change which sandbox file they touch.
- `bash`, `grep` and `find` run commands through `sandbox.exec`. pi's bash passes the host environment and writes host temp files, pi's grep spawns a host ripgrep, and `find` prunes `node_modules`, `.git`, `dist`, `build` and similar inside the sandbox and scans at most 20,000 entries.
- `ls` is pi's tool on sandbox-backed operations.

bash keeps at most `sandboxLimits.maxOutputBytes` of a command's output and notes when the rest was cut. Tool output over the cap (`JJ_OUTPUT_CAP_BYTES`, at most 64 KiB) is spilled whole through `spillOutput`; the model and the event see its head and tail and the artifact id.

## Run semantics

- Persistence: `onTurnComplete(entries)` receives the run's inputs and injected steering before the model call that sees them, an assistant message that calls tools before those tools run, and each tool result as soon as that tool finishes. Every exit persists what the engine handed over (repairs, inputs, drained inbox items), early exits included. After an abort, calls that never started get a "Not started: the run was stopped." result. System messages are never persisted; the prompt is rebuilt every run. Aborted or failed model responses are not persisted.
- Steering: `drainInbox()` is polled before the first model call and at every turn boundary; texts are injected as user messages through pi's steering hook.
- Budgets: `maxTurns` counts model calls in the run; the deadline aborts what is in flight. Either ends the run with `budget` when the model still wanted to continue.
- Abort: the signal cancels the model call and the running sandbox command; the command reports `interrupted` and the outcome is `aborted`. A sandbox released under the run (`SandboxReleasedError`, or a command interrupted with reason `release`) stops it the same way, with `reason: "sandbox_released"`.
- Timeouts: a model-chosen bash timeout is clamped to the profile's `sandboxLimits.execTimeoutMs` with `resolveExecTimeoutMs`.
- A collaboration tool returning `endRun` (complete_task) ends the run after its tool batch.
- Outcomes: `ended { finalText }`, `idle` (woken with no inputs and an empty inbox: nothing ran), `aborted { reason? }`, `budget { finalText }` and `error { code, error }`. Codes, shared with `ChatReplyError`: `auth`, `rate_limit`, `context_overflow` (pi-ai's `isContextOverflow`), `network`, `provider`, `invalid_request` and `unknown`. Error text has the provider key and anything key-shaped redacted, in outcomes and in `model.finished` events alike.
- Retries: a transient provider failure (429, 5xx, overload, a dropped connection; pi-ai's `isRetryableAssistantError`) is retried up to 3 times with exponential backoff from 1 s, at most 30 s apart, for every provider alike. SDK-level retries are off so nothing is retried twice.
- No context compaction: a session's transcript grows until the run stops at `maxTurns` or the deadline, or the model's context window is exceeded (an `error` outcome). Compacting would need a persisted compaction entry; it is out of scope for the MVP.

`configureOutboundProxy(env)` installs undici's `EnvHttpProxyAgent` as the global dispatcher, so the provider SDKs inside pi-ai (openai, @anthropic-ai/sdk and @google/genai, all on Node's global `fetch`) honour `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. Processes that call providers run it once at startup.

Tests use pi's faux provider, the scripted model and the `local` sandbox driver; none call a live model. `npm run smoke:runtime` runs one live tool cycle with `JJ_SMOKE_MODEL` (default `openai/gpt-6-luna`).
