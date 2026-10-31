# Verification contract

Status: task-level and session-level verification loops are agreed product requirements. Exact budgets, evaluators, storage, and retry policies remain to implement.

## Before execution

Each task defines its main goal, acceptance criteria, verification method, required evidence, and criteria for escalation. Each execution session receives a bounded objective, applicable task criteria, local verification checks, expected result, and the goal version it is working toward.

A session should not begin unbounded work with no way to assess the result. If verification cannot be specified, ask for clarification or return an explicit blocked/unverified outcome.

## Execution loop

Execute → verify → inspect failures → revise → verify again.

Persist each check's criterion, method, actual result, evidence reference, and associated session/run/goal version. Checks may pass, fail, or be unavailable/inconclusive. A completed model turn is not proof of successful verification.

Retries must have a configured stopping rule. On budget exhaustion, repeated non-progress, cancellation, or inability to verify, report a partial/failed/needs-input outcome with the evidence collected so far. Exact thresholds are open.

## Match checks to the work

| Work                         | Appropriate evidence                                                                             |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Code changes                 | Relevant tests, compiler/build result, or observed runtime behavior tied to an artifact/commit.  |
| Research                     | Claims compared with cited source passages, including unresolved contradictions.                 |
| File/data transformation     | Schema validation, input/output counts, integrity checks, and output artifact.                   |
| Browser operation            | Observed resulting state and operation record, rather than the fact that a click was dispatched. |
| Qualitative writing/planning | Explicit rubric and attributed review, with uncertainty preserved.                               |

A separate reviewer bot is useful for some work but not mandatory for every check. Tests and observable effects can be stronger evidence than another model agreeing.

## Integrated task completion

The coordinator checks the combined output against the task's acceptance criteria. Passing every local check is insufficient if the integrated output fails. Steering that changes the criteria invalidates stale verification; affected checks must run against the new goal version.

The final result reports what passed, what did not, evidence/artifact links, and known limitations. Do not mark a task successfully complete when required verification is failed or inconclusive.

## Milestone 1 checks

- Show a session producing output, failing a meaningful check, revising, and passing the check.
- Show task-level verification of the combined result.
- Attribute verification to the correct task/session/bot and expose it in the task activity view.
- Confirm steering affects subsequent execution and relevant checks.
- Confirm stopping a task prevents further launches and records descendant outcomes.
- Confirm reconnecting the UI does not repeat model runs or external actions.

The concrete demo input and pass/fail checks still need selection. Verification requirements are specified here; they have not yet been implemented or run.
