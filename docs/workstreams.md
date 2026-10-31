# Workstreams

Work is tracked in [GitHub Issues](https://github.com/LemonPhase/jj-bot/issues). Start at the [MVP epic](https://github.com/LemonPhase/jj-bot/issues/46), which lists the MVP issues as sub-issues in dependency order.

| Milestone                      | Scope                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| MVP                            | Multi-bot tasks on a real runtime; acceptance criteria in [milestone 1](milestone-1.md) |
| Phase 2 · Production hardening | Remote sandboxes, observability, spend caps, secrets, retention, published image        |
| Phase 3 · Open-source launch   | License, name, launch docs and the security model                                       |
| Later                          | Messaging channels, triggers, Git hosting, memory, teams, horizontal scale              |

## Picking up an issue

1. Choose an open issue in the current milestone with no open blockers. Its "blocked by" links are the source of truth for dependencies.
2. Assign yourself or comment to claim it.
3. Branch from `feat/revamp` until that branch merges into `main`, and open a PR that closes the issue.
4. Follow [CONTRIBUTING.md](../CONTRIBUTING.md): acceptance checks first, then implement, verify and record evidence in the PR.

Labels: `area: backend`, `area: frontend`, `area: shared` and `area: infra` route work; `decision` marks a choice to settle before dependent work; `epic` groups sub-issues.

Coordinate before touching shared files: `packages/contracts`, root dependencies, and shared web layout and styles.
