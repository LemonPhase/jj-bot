# Reference implementations

Selected documentation/source inspection on 31 October 2026. These repositories were not installed or run. Findings are architecture references, not claims that the products implement JJ Bot's complete design.

## Rakazo

Separates persistent bots, conversation threads, tasks, runs, and retry attempts. Its task record points to one bot and thread, so that record is not directly equivalent to our many-bot problem container. Peer messaging is distinct from temporary subagent execution.

- [Repository](https://github.com/elie222/rakazo)
- [Schema snapshot](https://github.com/elie222/rakazo/blob/26f284c8dbea1a272b70c4fb99ada4634034ba53/packages/db/prisma/schema.prisma)
- [Peer messaging](https://github.com/elie222/rakazo/blob/26f284c8dbea1a272b70c4fb99ada4634034ba53/packages/adapters/src/bot-messages.ts)
- [Subagent execution](https://github.com/elie222/rakazo/blob/26f284c8dbea1a272b70c4fb99ada4634034ba53/packages/adapters/src/pi-runtime-subagent.ts)

Borrow explicit identity/execution records, message attribution, duplicate-delivery handling, and separation of persistent peers from temporary workers.

## OpenMausBot

Separates persistent bot identities from independent conversation threads and multi-bot groups. The runtime stores parent/root assignment relationships, requester and assignee, completion criteria, lifecycle, results, and evidence. Work, consultation, and notification are distinct modes.

- [Repository](https://github.com/milind-soni/OpenMausBot)
- [Collaboration documentation](https://docs.openmausbot.com/docs/features/chat-and-teams)
- [Assignment types](https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/runtime/types.ts)
- [Runtime persistence](https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/server/runtime/store.ts)
- [Bot memory](https://github.com/milind-soni/OpenMausBot/blob/8c663d2b7647dcea04a2278dd0f794f591ae95e0/docs/memory.md)

Borrow durable decomposition and result-return paths while keeping JJ tasks distinct from provider session terminology.

## CopilotKit OpenBot

Uses durable coworker profiles, channels, AG-UI endpoints, per-agent group threads, and an attributed group transcript. Handoffs carry a task, constraints, and expected output through durable delivery with provenance.

- [Repository](https://github.com/CopilotKit/OpenBot)
- [Group schema](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/db/schema/group.ts)
- [Handoff tool](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/agents/handoff-tool.ts)
- [Handoff delivery](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/agents/handoff-delivery.ts)
- [Handoff runner](https://github.com/CopilotKit/OpenBot/blob/743649efc3f21d7bf0badbe6af2bcd5daedd97ce/server/src/agents/handoff-runner.ts)

Its architecture prose and inspected handoff delivery differ: prose describes the delegate's own user-facing conversation, whereas the pinned code executes in a scratch thread and relays back through the requester. Verify the selected revision before copying behavior. The template also has infrastructure/licensing dependencies described in its README; MIT repository licensing alone does not establish the terms of every dependency.

Borrow runtime separation, structured handoffs, shared transcript attribution, and persistent event provenance.
