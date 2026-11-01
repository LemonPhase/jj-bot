# Verification contract

Verification is opt-in per task. A task without a verification plan completes when its coordinator delivers the consolidated result. A task with a plan cannot complete until every criterion passes with evidence, judged against the goal version that produced the work.

## Capability

Plans are accepted only while bootstrap reports `capabilities.verification: true`. Contract 1.0 reports `false`: `POST /api/tasks` and `POST /api/tasks/:id/messages` refuse a body that carries a plan with `422 VERIFICATION_UNAVAILABLE` instead of storing a plan nothing enforces. The rest of this document is what enforcing plans means; it holds for any server that reports the capability.

## Always recorded

Gating is optional; the audit trail is not. Whether or not a task has a plan, the event log records every tool call and its result, every command's exit code, and every artifact produced. The product must never present an unverified result as verified.

## Defining a plan

A plan (`verificationPlanSchema`) lists one or more criteria, each with an `id`, a `description`, a verification `method` and the `expectedEvidence`. Plans are versioned with the goal: a change to the goal or its criteria starts a new goal version and supersedes earlier evidence. See [task continuation](task-continuation.md).

If verification cannot be specified for work that needs it, ask for clarification or return an explicit unverified outcome rather than inventing criteria.

## Execution loop

Execute → check → inspect failures → revise → check again, bounded by the session budget.

Each check records its criterion, method, outcome, evidence and the session, run and goal version it evaluated. Outcomes are `passed`, `failed` or `inconclusive`. A check cannot pass without evidence. When the budget runs out with a failed or inconclusive check, the task waits for the user or coordinator rather than completing.

## Evidence

Prefer checks that observe the work. A command run in the task's sandbox passes only on exit code 0 and keeps its exit code and output as evidence. A deterministic test against the result text keeps the match or parse outcome. A model review is a qualitative assessment, not a test: it keeps quoted observations, is labelled qualitative, and a malformed or evidence-free review is inconclusive. Tests and observed effects are stronger evidence than another model agreeing.

| Work                         | Appropriate evidence                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Code changes                 | Tests, a compiler or build result, or observed runtime behavior, run as commands.            |
| Research                     | Claims compared with cited source passages, including unresolved contradictions.             |
| File or data transformation  | Schema validation, input/output counts, integrity checks and the output artifact.            |
| Browser operation            | Observed resulting state and the operation record, not the fact that a click was dispatched. |
| Qualitative writing/planning | An explicit rubric and attributed review, with uncertainty preserved.                        |

## Integrated completion

For a task with a plan, the coordinator checks the combined output against the task's criteria; passing every session-level check is not sufficient if the integrated output fails. The final result reports what passed, what did not, the evidence and artifacts, and known limitations.
