# Contributing to JJ Bot

## Start with shared context

Read [AGENTS.md](AGENTS.md) and the local docs (`docs/development.md`, `docs/product-spec.md`, `docs/architecture.md`) first. When claiming a tracked team task, coordinating cross-lane changes, or handing off work, use the Notion context map in [AGENTS.md](AGENTS.md) to check or update the relevant task/handoff in [Hackathon HQ](https://app.notion.com/p/44ef1321420182e4acb781ba075ad9b0).

When working on a tracked task, record an accountable human owner plus any agent/session. Agree shared contracts and coordinate overlapping files before implementation. Use a focused branch (`codex/…` for agent branches) and keep unrelated changes separate.

## Required development verification loop

For substantive product work, define verification **before implementation** at two levels:

- Task: observable acceptance criteria, verification method and expected evidence for the integrated outcome.
- Execution/subtask/session: bounded objective, local checks, expected evidence and retry/budget or escalation limit.

Follow **implement → verify → inspect failures → revise → reverify**. Stop only when the acceptance checks pass with evidence, or report the unresolved failure/blocker and next action. A model saying “done,” a clean compile, or one worker's local success does not establish integrated task success.

Use checks appropriate to the change: typecheck/lint/build for integration errors; meaningful tests for domain/runtime behavior; real API/browser observations for user flows; cited source comparisons for factual work; and explicit rubrics for qualitative output. Do not add tests that merely mirror implementation. Run relevant checks, then repeat or broaden only for new changes, failures or unresolved risk.

Record **passed**, **failed** and **inconclusive/not run** distinctly. Keep command, observed result, evidence/artifact and limitations. Never present mocks as live model execution, an unrun test as passing, or a missing key as a successful integration. Recheck integrated output separately from worker results. If steering changes acceptance criteria, update the goal/check version and reject stale completion evidence.

The initial scaffold only needs setup, contract, build and smoke validation. The full live-agent verification suite belongs to the runtime and integration workstreams; this exception does not remove the standard for subsequent development.

## Before review or handoff

1. For the current iteration, run `npm run lint` and `npm test`. Add targeted acceptance checks when needed; explain checks that could not run. Typecheck/build remain available via `npm run check`, but do not expand routine validation unnecessarily.
2. Review the diff for credentials, generated files, unrelated changes and misleading readiness claims.
3. In the PR/task, state the problem, resulting behavior, checks/evidence and material limitations.
4. Update the existing Notion task and relevant runbook/handoff with commit links, result, blocker and exact next action. Mark Done only when its acceptance check passes. Keep Notion curated; do not paste conversation transcripts.

No API keys belong in code, Notion or browser bundles. The scaffold API is a local development service, not a public deployment; authentication and external-action controls must be implemented before exposing agent capabilities.
