# Reference implementations

Design references for JJ Bot. Rakazo and OpenMausBot are the closest comparable open-source products. Sources were inspected at documentation and selected-source level on 31 October 2026, not installed or run, so these are architecture references rather than claims about complete product behavior.

## How JJ Bot differs

Rakazo binds each task to one bot and thread, and OpenMausBot decomposes work into hierarchical assignments. JJ Bot makes the task a shared container: many bots, one coordinator, one attributed group chat, and parallel execution sessions. Its execution environment is a pluggable sandbox configured per runtime profile, rather than the host process or a local CLI.

## Rakazo

Separates persistent bots, conversation threads, tasks, runs and retry attempts. Its task record points to one bot and thread, so it is not equivalent to JJ Bot's many-bot task. Peer messaging is distinct from temporary subagent execution. Its subagents run on the pi runtime — the same runtime JJ Bot uses — with at most four helpers in parallel and no deeper helper nesting.

- [Repository](https://github.com/elie222/rakazo)
- [Schema snapshot](https://github.com/elie222/rakazo/blob/26f284c8dbea1a272b70c4fb99ada4634034ba53/packages/db/prisma/schema.prisma)
- [Peer messaging](https://github.com/elie222/rakazo/blob/26f284c8dbea1a272b70c4fb99ada4634034ba53/packages/adapters/src/bot-messages.ts)
- [Subagent execution on pi](https://github.com/elie222/rakazo/blob/26f284c8dbea1a272b70c4fb99ada4634034ba53/packages/adapters/src/pi-runtime-subagent.ts)

Borrow explicit identity and execution records, message attribution, duplicate-delivery handling, separation of persistent peers from temporary workers, and its concurrency and nesting caps as a starting point.

## OpenMausBot

Separates persistent bot identities from independent conversation threads and multi-bot groups. The runtime stores parent and root assignment relationships, requester and assignee, completion criteria, lifecycle, results and evidence. Work, consultation and notification are distinct modes. Its product runs local Claude, Codex and Grok CLI engines rather than an embedded runtime.

- [Repository](https://github.com/milind-soni/OpenMausBot)
- [Collaboration documentation](https://docs.openmausbot.com/docs/features/chat-and-teams)
- [Assignment types](https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/runtime/types.ts)
- [Runtime persistence](https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/runtime/store.ts)
- [Bot memory](https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/docs/memory.md)

Borrow durable decomposition and result-return paths — the assignment model is the strongest reference for JJ Bot's coordination design.

## CopilotKit OpenBot

Uses durable coworker profiles, channels, per-agent group threads and an attributed group transcript. Handoffs carry a task, constraints and expected output through durable delivery with provenance.

- [Repository](https://github.com/CopilotKit/OpenBot)
- [Group schema](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/db/schema/group.ts)
- [Handoff tool](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/agents/handoff-tool.ts)
- [Handoff delivery](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/agents/handoff-delivery.ts)
- [Handoff runner](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/agents/handoff-runner.ts)

Its architecture prose and inspected handoff delivery differ: the prose describes the delegate's own user-facing conversation, whereas the pinned code executes in a scratch thread and relays back through the requester. Verify the selected revision before copying behavior.

Borrow structured handoffs, shared transcript attribution and persistent event provenance.
