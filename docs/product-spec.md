# JJ Bot · Product specification

The behavioral contract. Code and tests establish current implementation; team decisions live in the Project Brief.

## Purpose

JJ Bot is an open, self-hostable multi-bot agent workspace, an open alternative to Grok's bot. It runs on a user's machine or a server. Users work with persistent bots, hand them goals, and watch several bots collaborate on real work through a shared task chat and a live execution view.

## Core concepts

| Concept           | Meaning                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot               | Persistent persona with instructions, a model choice, a runtime profile, memory and its own conversations.                                      |
| Task              | A problem with a goal, a coordinator, participating bots, a shared group chat, execution sessions and results. A verification plan is optional. |
| Execution session | An independently contextualized agent run doing part of a task's work, with real tools inside a sandbox. Sessions can delegate further.         |
| Coordinator       | The bot responsible for delegating work and consolidating the task result. Initially the task creator; coordination can transfer.               |
| Runtime profile   | The user's settings for how a bot executes: sandbox driver, resources, network access, tools and budgets.                                       |

Bots and tasks are many-to-many. A bot can work on many tasks and a task can involve many bots. A task persists across all the sessions used to solve it; it is not one provider conversation or one model run.

## Task chat and execution

1. A user asks a bot to do something.
2. The bot answers directly, starts a task, or forwards the request to an active task it already participates in. Greetings, thanks and status questions never create tasks, and a follow-up extends the existing task rather than duplicating it.
3. The creating bot coordinates the task and brings in participating bots.
4. The coordinator delegates bounded work; each piece runs as its own execution session with a brief and selected context.
5. Sessions do real work — running commands, reading and writing files — inside the sandbox their bot's runtime profile selects. Sessions of one task can share a workspace.
6. Task messages are visible to every participating bot. Visibility does not trigger a turn in every bot.
7. Bots can message each other directly to align work.
8. Results return to the coordinator, which consolidates them into the task result.

Bot memories and private conversation histories are never implicitly merged. Access to the task transcript does not mean injecting the whole transcript into every model call.

## User control

The user can open any task's group chat and steer it. Steering reaches the coordinator and changes subsequent execution. Stop cancels active sessions and prevents new launches; it does not undo external effects that already happened.

A finished task can be continued. Continuing under unchanged criteria keeps the goal version; changing the goal or its criteria starts a new version and supersedes earlier evidence. See [task continuation](task-continuation.md).

Users configure models and runtime profiles in settings, and choose per bot which ones it uses.

## Verification

A task may carry a verification plan. With a plan, it cannot complete until every criterion passes with evidence. Without one, it completes when the coordinator delivers the consolidated result. Tool activity and artifacts are recorded either way. See [Verification](verification.md).

## Visualization

From a task, the user can see the participating bots, the sessions each dedicated to it, what they said to each other, the commands and file changes they made, results, and any verification evidence. Show actual operational events. Never claim to expose private model reasoning.

## Scale

Multi-bot execution is the core of the product, not an extension. The design supports an arbitrary configurable bot count with no hard-coded two-bot logic. Provider limits, budgets and compute cap practical concurrency; additional work queues. Effectiveness at large team sizes is not guaranteed.

## Still open

- Product name and license.
- Qualitative review rubrics and per-task escalation policy.
- The final visualization layout.
- Multi-user identity, roles and shared-resource permissions.

## Context

- [Project Brief](https://app.notion.com/p/40af1321420181d29d55cfb6d70b6eea)
- [Build Runbook](https://app.notion.com/p/40af132142018125ac46e0b80cda7ea9)
