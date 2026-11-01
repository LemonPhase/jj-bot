# Workstreams

How work on JJ Bot is organised. Work is tracked in [GitHub Issues](https://github.com/LemonPhase/jj-bot/issues); issues hold status, ownership, dependencies and handoffs, and this file holds none of them.

## Milestones

Issues are grouped into milestones by phase:

| Milestone                      | Scope                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| MVP                            | Multi-bot tasks on a real runtime; acceptance criteria in [milestone 1](milestone-1.md) |
| Phase 2 · Production hardening | Running unattended on a server: remote sandboxes, observability, spend caps, secrets    |
| Phase 3 · Open-source launch   | License, name, launch docs and the security model                                       |
| Later                          | Product extensions after launch                                                         |

A milestone can have an `epic` issue that lists its work as sub-issues in dependency order, such as the [MVP epic](https://github.com/LemonPhase/jj-bot/issues/46). Dependencies between issues are native "blocked by" links, which are the source of truth.

## Labels

- `area: backend` (API, worker, runtime, sandbox, storage), `area: frontend` (web app), `area: shared` (contracts, or work spanning both) and `area: infra` (build, CI, packaging, deployment) route work.
- `decision` marks a choice to settle and record before dependent work; once settled, its contract goes into the docs and the issue closes.
- `epic` groups sub-issues; `bug`, `documentation` and `accessibility` classify the rest.

## Picking up an issue

1. Choose an open issue with no open blockers.
2. Assign yourself or comment to claim it, naming the accountable human owner and any agent or session.
3. If it lacks acceptance criteria and expected evidence, add them first.
4. Branch from the latest `main`, one branch per issue, and open a PR against `main` that closes the issue (`Closes #N`).
5. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for the checks, the PR description and review.

Coordinate on the issue before touching shared files: `packages/contracts`, root dependencies, and shared web layout and styles. New work found along the way gets its own issue rather than growing the current one.
