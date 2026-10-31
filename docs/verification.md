# Verification contract

Verification is opt-in per task. A task without a verification plan completes when its coordinator delivers the consolidated result. A task with a plan cannot complete until every criterion passes with evidence, judged against the goal version that produced the work.

Plans are accepted only while the API reports the `verification` capability. Without it, the API rejects a task or steering command that carries a plan instead of storing a plan nothing enforces.

## Always recorded

Gating is optional; the audit trail is not. Whether or not a task has a plan, the event log records every tool call and its result, every command's exit code, and every artifact produced. The product must never present an unverified result as verified.

## Defining a plan

A plan lists criteria, each with an id, a description, a verification method and the evidence expected. A criterion can carry an executable check. Plans are versioned with the goal: a change to the goal or its criteria starts a new goal version and supersedes earlier evidence. See [task continuation](task-continuation.md).

If verification cannot be specified for work that needs it, ask for clarification or return an explicit unverified outcome rather than inventing criteria.

## Execution loop

Execute → check → inspect failures → revise → check again, bounded by the session budget.

Each check records its criterion, method, outcome, evidence and the session, run and goal version it evaluated. Outcomes are `passed`, `failed` or `inconclusive`. A check cannot pass without evidence. When the budget runs out with a failed or inconclusive check, the task waits for the user or coordinator rather than completing.

## Check kinds

| Kind                        | What runs                                                   | Evidence                                  |
| --------------------------- | ----------------------------------------------------------- | ----------------------------------------- |
| `contains`, `regex`, `json` | A deterministic test against the result text                | The match or parse outcome                |
| `command`                   | A command in the task's sandbox; passes only on exit code 0 | Exit code and captured output             |
| Model review                | A separate reviewer call against the criterion and context  | Quoted observations; qualitative by label |

The regex subset rejects groups, alternation, backreferences and multiple quantifiers by design. Model reviews are qualitative assessments, not tests: a malformed or evidence-free review is inconclusive. Prefer a `command` check whenever the work can be observed — tests and observed effects are stronger evidence than another model agreeing.

## Match checks to the work

| Work                         | Appropriate evidence                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| Code changes                 | Tests, a compiler or build result, or observed runtime behavior, run as `command` checks.    |
| Research                     | Claims compared with cited source passages, including unresolved contradictions.             |
| File or data transformation  | Schema validation, input/output counts, integrity checks and the output artifact.            |
| Browser operation            | Observed resulting state and the operation record, not the fact that a click was dispatched. |
| Qualitative writing/planning | An explicit rubric and attributed review, with uncertainty preserved.                        |

## Integrated completion

For a task with a plan, the coordinator checks the combined output against the task's criteria; passing every session-level check is not sufficient if the integrated output fails. The final result reports what passed, what did not, the evidence and artifacts, and known limitations.
