# Contributing to JJ Bot

## Start with shared context

Read [AGENTS.md](AGENTS.md) and the local docs (`docs/development.md`, `docs/product-spec.md`, `docs/architecture.md`) first. Claim work, coordinate cross-lane changes and hand off through [GitHub Issues](https://github.com/LemonPhase/jj-bot/issues), as described in [docs/workstreams.md](docs/workstreams.md).

## Branches and pull requests

- Branch from the latest `main`, one branch per issue, named `<kind>/<topic>` (`feat/compose`, `fix/artifacts-after-handoff`, `docs/demo-task`). Keep unrelated changes on separate branches.
- Open the PR against `main` with `Closes #N`. Its description states the problem, the resulting behavior, the verification (commands and observed results, with what passed, failed or did not run) and known limits.
- Pull requests run CI on their merge result. Keep the branch current with `main` and re-run the checks after merging it in.
- Agree changes to `packages/contracts` on the issue first, bump `CONTRACT_VERSION` and add an entry to [the contract changelog](docs/contract-changelog.md).

## Required development verification loop

For substantive product work, define verification **before implementation** at two levels:

- Task: observable acceptance criteria, verification method and expected evidence for the integrated outcome.
- Execution/subtask/session: bounded objective, local checks, expected evidence and retry/budget or escalation limit.

Follow **implement → verify → inspect failures → revise → reverify**. Stop only when the acceptance checks pass with evidence, or report the unresolved failure/blocker and next action. A model saying “done,” a clean compile, or one worker's local success does not establish integrated task success.

Use checks appropriate to the change: typecheck/lint/build for integration errors; meaningful tests for domain/runtime behavior; the shared conformance suite for any sandbox driver; real API/browser observations for user flows; cited source comparisons for factual work; and explicit rubrics for qualitative output. Do not add tests that merely mirror implementation. Run relevant checks, then repeat or broaden only for new changes, failures or unresolved risk.

Record **passed**, **failed** and **inconclusive/not run** distinctly. Keep command, observed result, evidence/artifact and limitations. Never present mocks as live model execution, an unrun test as passing, or a missing key as a successful integration. Recheck integrated output separately from worker results. If steering changes acceptance criteria, update the goal/check version and reject stale completion evidence.

Docs hold invariants, not progress. Keep `docs/` to contracts, boundaries, semantics and constraints; put status, evidence and handoffs in the issue and the PR. Record schema changes in `docs/contract-changelog.md`, and delete stale claims instead of layering corrections.

## Checks

- `npm run lint` and `npm test` are the quick baseline; `npm run format` applies Biome's formatting and safe fixes.
- `npm run verify` (alias `npm run check`) is the gate CI runs: lint, all-package typecheck, tests and the web build. Set `JJ_TEST_DATABASE_URL` and build the sandbox image to run the PostgreSQL and Docker tests that otherwise skip.
- `npm run smoke:e2e` runs the whole server over HTTP on the scripted model; with `JJ_SMOKE_BASE_URL` it drives a running stack instead, such as the compose one.
- `npm run smoke:runtime` runs one live pi tool cycle in a local sandbox on a real model (`JJ_SMOKE_MODEL` and its key), and `JJ_SMOKE_MODEL=<provider/model> npm run smoke:e2e` runs the whole flow on one. These are the only checks that call a live model; CI runs neither.

[Development setup](docs/development.md#checks) has the details and what CI runs.

## Review and handoff

1. Run the checks the change needs, at least `npm run verify`, and the smoke scripts for runtime, API or deployment changes. Explain any check that could not run.
2. Review the diff for credentials, generated files, unrelated changes and misleading readiness claims.
3. Get an independent review of the diff, by a person or an agent session that did not write it, against the issue's acceptance criteria. Fix what it finds, re-run the affected checks, and record the findings and their fixes in the PR.
4. Merge once CI passes and the acceptance criteria hold with evidence; the PR closes the issue. If you stop before then, comment on the issue with commit or PR links, results, blockers and the exact next action. Keep issues curated; do not paste conversation transcripts.

No API keys belong in code, issues or browser bundles. The API has one shared bearer token and no per-user identity: never expose it beyond loopback except behind HTTPS.
