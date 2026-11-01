# Context management and bot-to-bot communication (#68)

Research for issue #68. This directory is not product code.

1. [01-today.md](01-today.md): how context and messaging work today, with file:line references and measurements.
2. [02-survey.md](02-survey.md): a sourced survey of multi-agent communication and context-engineering approaches. Each claim is tagged by how it was verified: page opened, repository read, or search snippet only.
3. [03-experiments.md](03-experiments.md): proposed experiments E0–E4, with metrics and cost estimates.
4. [04-options.md](04-options.md): how the surveyed approaches fit JJ Bot, design options A, B and C, and a recommendation (a proposal).

The harness boots the engine in-process and records every model request:

    node --import tsx research/context-management/harness.ts <baseline|followups|chat> [provider/model]
    node research/context-management/show.cjs

Reports go to `results/`, which git ignores.
