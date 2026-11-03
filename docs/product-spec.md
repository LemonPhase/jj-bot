# JJ Bot · Product specification

The behavioral contract. Code and tests establish current implementation; open product decisions are tracked as `decision` issues.

## Purpose

JJ Bot is an open, self-hostable multi-bot agent workspace, an open alternative to Grok's bot. It runs on a user's machine or a server. Users work with persistent bots, hand them goals, and watch several bots collaborate on real work through a shared task chat and a live execution view.

## Core concepts

| Concept           | Meaning                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot               | Persistent persona with instructions, a model choice, a runtime profile, memory and its own conversations.                                      |
| Task              | A problem with a goal, a coordinator, participating bots, a shared group chat, execution sessions and results. A verification plan is optional. |
| Execution session | An independently contextualized agent run doing part of a task's work, with real tools inside a sandbox. Sessions can delegate further.         |
| Coordinator       | The bot responsible for delegating work and consolidating the task result: the one the user names, or the bot that created the task from chat.  |
| Runtime profile   | The user's settings for how a bot executes: sandbox driver, resources, network access, tools and budgets.                                       |

Bots and tasks are many-to-many. A bot can work on many tasks and a task can involve many bots. A task persists across all the sessions used to solve it; it is not one provider conversation or one model run.

## Task chat and execution

1. A user asks a bot to do something.
2. The bot answers directly, starts a task, or passes the request on to a task it already takes part in, running or finished. Greetings and thanks are answered directly, and a question about its tasks ("how did it go?") from what the bot looks up in them. A follow-up continues the existing task, in its own workspace, rather than starting a new one.
3. The bot that creates a task coordinates it and chooses its participating bots. A user can also create a task directly, naming the coordinator and the participants.
4. The coordinator delegates bounded work; each piece runs as its own execution session with a brief and selected context.
5. Sessions do real work — running commands, reading and writing files — inside the task's sandbox, which the coordinator's runtime profile selects. Every session of a task shares its workspace.
6. Every task message is posted, attributed, to the task's shared chat. Posting is not activation: only an assignment, a result or steering starts work, and a bot's model is given only the messages delivered to its own sessions. Any session can look up the rest of its task's log, and every session's brief and report, with read-only tools.
7. Bots can message each other directly to align work.
8. Results return to the coordinator, which consolidates them into the task result.

Bot memories and private conversation histories are never implicitly merged, and no bot reads another session's transcript.

When a task completes, fails or needs the user's answer, its coordinator tells the user in its direct chat, in its own words, with the task's card under the message. The card shows the task's current status and the start of its result or error once it has finished, or of the coordinator's question while it waits for the user. A bot in chat can only look its tasks up while it tells such an update; acting on it (continuing or stopping the task) waits for the user. The update is never lost: if the bot cannot write it, the plain result is posted instead.

## User control

The user can open any task's group chat and steer it. Steering reaches the coordinator and changes subsequent execution. Stop cancels active sessions and prevents new launches; it does not undo external effects that already happened. The user can also ask a task's coordinator in direct chat to stop it.

A finished task can be continued. Continuing under unchanged criteria keeps the goal version; changing the goal or its criteria starts a new version and supersedes earlier evidence. See [task continuation](task-continuation.md).

Settings show which model providers the server has keys for and edit runtime profiles; each bot chooses its model and profile. Model keys are configured on the server, never in the product.

## Verification

A task may carry a verification plan, but only on a server that reports the `verification` capability; otherwise a plan is refused rather than stored unenforced. With a plan, a task cannot complete until every criterion passes with evidence. Without one, it completes when the coordinator delivers the consolidated result. Tool activity and artifacts are recorded either way. See [Verification](verification.md).

## Visualization

From a task, the user can see the participating bots, the sessions each dedicated to it, what they said to each other, the commands and file changes they made, results, and any verification evidence. Show actual operational events. Never claim to expose private model reasoning.

## Scale

Multi-bot execution is the core of the product, not an extension. The design supports an arbitrary configurable bot count with no hard-coded two-bot logic. Provider limits, budgets and compute cap practical concurrency; additional work queues. Effectiveness at large team sizes is not guaranteed.
