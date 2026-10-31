# Direct Gemini execution

`GeminiSessionExecutor` runs a bounded, backend-owned session through the Google GenAI Interactions API. Every request uses `store:false`; subsequent tool/revision requests retain the full returned step history. No provider reasoning is emitted to the UI.

Input carries one bot persona, session brief/goal version, selected context, abort signal, operational event sink, optional tools and executable check definitions. The caller owns persistence, job leases, task-wide cancellation and stale-goal completion guards.

Default tools are `add_numbers` and `read_context`. No shell/browser access is granted. Custom tools are explicitly registered and their supported JSON-schema argument types/required fields/enums are checked before execution. Tool errors return as tool results; cancellation is propagated. Tools must honor the signal and report uncertain external effects honestly.

Checks run after each candidate. `contains`, restricted `regex`, and `json` checks are deterministic; regex intentionally rejects groups, alternation, backreferences and multiple quantifiers. Missing executable definitions use a separate model reviewer against the declared criterion/context. Model reviews are labeled qualitative assessments, require attributed evidence, and are not equivalent to deterministic tests. Malformed or evidence-free reviews are inconclusive. Failing checks feed a bounded revision loop.

Limits default to 20 total model calls, two revisions, a 120-second session deadline and at most 32 criteria/tool calls per batch. Exceeding a deadline/model budget throws; exhausting revisions returns final failed/inconclusive checks. Only the coordinator may determine integrated task completion.

Unit tests use an injected client; they do not assert real model/provider access. The root integration smoke tests cover the live model/tool path separately.
