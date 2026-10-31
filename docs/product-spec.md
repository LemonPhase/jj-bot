# JJ Bot · Product specification

Status: agreed product design. This document is the behavioral contract; code and tests establish current implementation. Later team decisions live in the Project Brief.

## Purpose

JJ Bot is an autonomous personal-agent system, described by the team as an open alternative to Grok Bot. A frontend connects to a backend on a user's machine or a server. Users interact with persistent bots, delegate work, and inspect collaboration through a task group chat and execution visualization.

## Core concepts

| Concept           | Meaning                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot               | Persistent persona with memory and its own conversations. Orchestrates tasks, communicates with other bots, and starts execution sessions.  |
| Task              | A particular problem, its main goal, verification criteria, shared group chat, participating bots, execution sessions, and results.         |
| Execution session | An independently contextualized agent execution environment doing part of the work for a task. Can involve delegated subagents/subsessions. |
| Coordinator       | One bot responsible for reconciling contributions and consolidating the task result. Initially the task creator; coordination can transfer. |

Bots and tasks have a many-to-many relationship. A bot may create or contribute to many tasks; several bots may work on one task. A task is not synonymous with a provider conversation or a single model run. It persists across the sessions used to solve the problem. The task/process and session/thread analogy is conceptual, not a requirement to use operating-system processes or threads.

## Task chat and execution

1. A user asks a bot to perform work.
2. The bot can create a task when needed, with its goal and verification criteria.
3. The creating bot initially coordinates the task and brings in participating bots.
4. Participating bots may launch execution sessions within the agreed scope.
5. Task messages are visible to all bots participating in that task. Visibility does not automatically trigger a turn in every bot.
6. Bots can communicate directly to align context and directions.
7. Sessions receive explicit briefs and selected context, and return results with verification evidence.
8. The coordinator reconciles contributions and verifies the integrated result.

Bot memories and full conversation histories are not implicitly merged. Availability of the task transcript does not require injecting the full transcript into every model call.

A direct message is routed before work starts. The bot may answer it conversationally, turn it into a new task, or forward it to an active task it already participates in. Greetings, thanks and status questions must not create tasks; only requests for new execution create work, and a follow-up should extend the existing task rather than duplicate it.

## User control

The user can open the task group chat and send steering messages. The coordinator updates the plan and informs affected execution sessions. Stop task cancels active execution sessions. Cancellation does not undo already completed external effects. Exact interruption timing, acknowledgement, and tool cancellation behavior remain implementation details.

A finished task can be continued. Continuing work under unchanged criteria keeps the goal version; changing the goal or its acceptance criteria starts a new version and supersedes earlier evidence. See [task continuation and goal versioning](task-continuation.md).

## Visualization

From a task, the user can inspect participating bots, which sessions they have dedicated to it, what contributions they sent, and execution progress. Show actual operational events, tool activity, results, and verification evidence. Do not claim to expose private model reasoning.

The precise visual layout is open. A graph and timeline are implementation candidates, not agreed requirements.

## Scale and milestone scope

Multi-bot execution and visualization belong in the first milestone. At least two bots must do real work in separate sessions. The design must support an arbitrary configurable bot count, without hard-coded two-bot logic. Provider limits and compute impose practical concurrency limits; additional work may be queued. Effectiveness at large team sizes is not guaranteed.

Every task and execution session includes a verification loop; see [Verification](verification.md).

## Still open

- The first concrete demo task, target persona, broader tool catalogue, and sample inputs.
- Qualitative review rubrics and per-task escalation policy.
- The final visualization layout.
- Real user identity, tool permissions, shared-resource isolation, and deployment details.
- License and public distribution policy.

## Context

- [Project Brief](https://app.notion.com/p/40af1321420181d29d55cfb6d70b6eea)
- [Build Runbook](https://app.notion.com/p/40af132142018125ac46e0b80cda7ea9)
