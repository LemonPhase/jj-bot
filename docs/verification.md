# Verification contract

A task may not complete on the strength of a finished model turn. Verification is bound to the goal version that produced the work.

## Before execution

Each task defines its main goal, acceptance criteria, verification method, required evidence, and criteria for escalation. Each execution session receives a bounded objective, applicable task criteria, local verification checks, expected result, and the goal version it is working toward.

A session must not begin unbounded work with no way to assess the result. If verification cannot be specified, ask for clarification or return an explicit blocked or unverified outcome.

## Execution loop

Execute → verify → inspect failures → revise → verify again.

Persist each check's criterion, method, actual result, evidence reference, and associated session/run/goal version. Checks may pass, fail, or be unavailable/inconclusive. A completed model turn is not proof of successful verification.

Retries have a stopping rule. A session gets three recovery attempts before it fails and the task moves to a waiting state rather than reporting success. The runtime bounds a session to 20 model calls, two revisions, a 120-second deadline, and at most 32 criteria/tool calls per batch. On exhaustion, cancellation, or inability to verify, report a partial, failed, or needs-input outcome with the evidence collected.

## Check semantics

- `contains`, restricted `regex` and `json` checks are deterministic and run against the candidate result. The regex subset rejects groups, alternation, backreferences and multiple quantifiers by design.
- When no executable definition exists, a model review runs against the declared criterion and context. Reviews must return attributed evidence and are labelled qualitative assessments, not deterministic tests. Malformed or evidence-free reviews are inconclusive.
- A check cannot pass without evidence. Failure feeds a bounded revision loop; exhausting it returns failed or inconclusive checks.
- Checks record the goal version they were evaluated against. Steering that changes the goal increments the version and invalidates stale results.

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

The final result reports what passed, what did not, evidence or artifact references, and known limitations. A task is not marked successfully complete when required verification is failed or inconclusive.
