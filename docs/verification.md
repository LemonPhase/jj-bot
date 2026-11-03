# Verification contract

Verification is opt-in per task. A task without a verification plan completes when its coordinator delivers the consolidated result. A task with a plan completes only when every criterion passes with evidence, judged against the goal version that produced the work.

## Capability

Plans are accepted only while bootstrap reports `capabilities.verification: true`. A server that reports `false`, such as the web app's demo mode, refuses a body that carries a plan (`POST /api/tasks`, `POST /api/tasks/:id/messages`) with `422 VERIFICATION_UNAVAILABLE` instead of storing a plan nothing enforces.

## Always recorded

Gating is optional; the audit trail is not. Whether or not a task has a plan, the event log records every tool call and its result, every command's exit code, and every artifact produced. The product never presents an unverified result as verified.

## Defining a plan

A plan (`verificationPlanSchema`) is 1 to 20 criteria, each with an `id` (a slug, unique in the plan), a `description` and a `method`:

| Method    | Passes when                                                                                                                                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command` | `sh -c <command>`, run in the task's sandbox from the workspace root, exits with code 0 without interruption. `timeoutSeconds` can only shorten the sandbox's limit.                                                                                                                             |
| `file`    | A workspace file (`path`, workspace-relative) `exists`, `contains` a value, `matches` a regular expression (`flags` from i, m and s), or parses as `json`, valid against an optional JSON Schema (`schema`; no reference keywords such as `$ref`, at most 20,000 characters and 32 levels deep). |
| `result`  | The result text the coordinator passed to `complete_task` `contains`, `matches` or is `json`, as for a file.                                                                                                                                                                                     |

Only the user writes a plan: when creating the task, or with a task message (`verificationPlan`; `null` removes it). No agent tool sets or changes criteria, so a coordinator never grades its own work; it may suggest checks in its reply, and the user adopts them. If verification cannot be specified for work that needs it, the coordinator asks for clarification or returns an explicit unverified outcome rather than inventing criteria.

Plans are versioned with the goal: a change to the plan, with or without a change to the goal, needs the goal version the user observed and starts a new goal version. A message that repeats the current plan changes nothing. See [task continuation](task-continuation.md).

## The gate

The coordinator sees the plan in its prompt. Calling `complete_task` on a task with a plan records the completion request. When the coordinator's turn ends, after the run's last tool, so nothing batched after `complete_task` can change the workspace behind a check, the worker runs every criterion in plan order:

- **All passed:** the request records the passing attempt, and the task completes.
- **Otherwise:** the request is cleared and the task does not complete. The coordinator receives each criterion's outcome, exit code, duration and the tail of its output (at most 2 KiB per failing check) as a result, and its run goes on: it revises the work and calls `complete_task` again, which runs every check again.
- **Attempts:** at most `JJ_MAX_VERIFICATION_ATTEMPTS` (default 3) gate runs per coordinator run. After the last failed one `complete_task` refuses; the coordinator tells the user what fails and the task waits for the user. A single check is never retried automatically, so a flaky test shows as failed.
- **One place completes a task, in the run whose gate passed.** A passing attempt is recorded with the run that ran it, and the transaction that completes the task checks again that this run's gate passed: every criterion of the current plan passed at that attempt, and the attempt is its goal version's latest. A request that did not pass this run's gate, whatever recorded it, leaves the task waiting with a system message, never completed. A run cut off during or after its gate leaves evidence another run cannot use: the session's recovery runs the gate again, on the workspace as it then is, as a new attempt. Attempt numbers are never reused.

Outcomes are `passed`, `failed` or `inconclusive`, and inconclusive blocks completion just as failed does. A check is inconclusive when its sandbox is unavailable or released, the run is stopped, a command's interruption cannot be confirmed, a file is over 1 MiB, the run's time budget ran out before or while it ran, or a regular expression or JSON Schema did not finish within 2 s. Those two run in a separate thread that is stopped at its limit, so a pattern that backtracks catastrophically never blocks the server. The 2 s start once the thread is ready, so starting threads on a busy host does not count. A thread that has used less than 0.1 s of processor time by then was kept waiting by a busy host rather than slow: it gets up to 3 s more, and if it has still not finished the check is inconclusive with the host, not the pattern, named as the cause. A check that does need more than 0.1 s of processor time (a schema over a large value) can still be stopped at 2 s on a loaded host, and is then reported as a pattern that may backtrack catastrophically. On Node 22.12–22.18, which cannot report a thread's processor time, only the clock counts. A command that exceeds its own timeout fails. A check cannot pass without evidence: every check records what it observed.

Checks run in the same sandbox as the agents, with the coordinator's profile: its network policy, resource and command limits, and no secrets. On `local` they are as unisolated as the agents' commands. Command and deterministic checks make no model calls; the coordinator's revision turns are ordinary model calls, bounded by its run budgets and spend caps.

A check tests the workspace as the agents left it, not their intent: agents that can edit the workspace can also edit what a command runs (a test script, a fixture). The recorded output lets the user judge, and checks that run fixed commands against fixed paths are harder to defeat.

## Evidence

Each check is an append-only record (`verificationCheckSchema`): the criterion, method, goal version, attempt, outcome, exit code and interruption, duration, what was observed (`detail`), the output preview, the artifact holding its full output, the session and run, and timestamps. Command output is redacted before it is capped; where the sandbox's limit cut it (the end of the head, the start of the tail) or a timeout or abort stopped it, a piece of a secret of at least 4 characters is redacted too. A `matches` check quotes the match with both ends treated as cuts, so a match that is part of a secret, a database URL's password included, is quoted redacted. A `json` check that fails says where the text stops being JSON, by line and column, and quotes none of it. The sandbox keeps at most its `maxOutputBytes` of a command's output (256 KiB by default): the head and the tail, with a note on how much was left out between them. The record keeps the head and tail of that (at most 8 KiB, and never more than `JJ_OUTPUT_CAP_BYTES`), and everything kept is stored as an `output` artifact when it does not fit. The events `verification.started`, `verification.checked` (the record) and `verification.finished` show the gate in the task's event log.

A task view carries the checks of the latest attempt of each goal version; earlier attempts stay in the event log. Evidence of an older goal version is superseded: it is shown as such and never counts for the current version.

Prefer checks that observe the work. Tests and observed effects are stronger evidence than another model agreeing.

| Work                         | Appropriate evidence                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Code changes                 | Tests, a compiler or build result, or observed runtime behavior, run as commands.            |
| Research                     | Claims compared with cited source passages, including unresolved contradictions.             |
| File or data transformation  | Schema validation, input/output counts, integrity checks and the output artifact.            |
| Browser operation            | Observed resulting state and the operation record, not the fact that a click was dispatched. |
| Qualitative writing/planning | An explicit rubric and attributed review, with uncertainty preserved.                        |

Model-review checks (a qualitative review against a rubric, labelled as such, inconclusive when malformed or without quoted evidence), checks attached to a brief, an on-demand way to run the checks before completing, and plans dictated in direct chat are not part of the contract yet.

## Showing verification

`verificationSummary` derives where a task stands for its current goal version (`pending`, `passed`, `failed` or `inconclusive`, with counts and the attempt) from its plan and checks; task summaries carry it as `verification`. `isVerified` is the one rule for showing a task as verified: it completed, and every criterion of its current plan passed at the latest attempt of its current goal version. A status, a finished model turn or a passing session never counts on its own. A task without a plan is never shown as verified.

## Integrated completion

For a task with a plan, the gate checks the combined output in the shared workspace; passing every session-level check is not sufficient if the integrated output fails. The final result reports what passed, what did not, the evidence and artifacts, and known limitations.
