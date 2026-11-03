# Glossary

The words JJ Bot's docs, code and issues use for its execution model. Use them exactly as defined here. [Architecture](architecture.md) has the contracts that rest on them.

## Who does the work

| Term                              | Meaning                                                                                                                                                                                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Bot**                           | A persona the user creates: name, role, instructions, model, runtime profile and a memory note. A bot is a record, not something running; it acts only through sessions. One bot can work on many tasks at once.                                                           |
| **Task**                          | One piece of work the user asks for: a goal, a roster of participating bots, a status and a final result. Each task has one coordinator and one shared workspace.                                                                                                          |
| **Coordinator**                   | The bot that runs a task. It splits the work, receives results and is the only one that can complete the task.                                                                                                                                                             |
| **Worker**                        | A bot doing a piece of work delegated to it. _Coordinator_ and _worker_ are roles a bot takes within a task, not kinds of bot.                                                                                                                                             |
| **Execution session** (_session_) | One bot doing one piece of work in one task, with its own transcript and inbox. The coordinator's session is the **root session**; each delegation creates a **child session** for the worker. A bot can have several sessions in one task, for example one per follow-up. |
| **Run**                           | One active stretch of a session: it wakes, makes model calls, then waits or finishes. A session usually has several runs.                                                                                                                                                  |
| **Direct chat**                   | A conversation between the user and one bot, outside any task. Each reply is a short, stateless model loop that can look up, create, continue or stop the bot's tasks.                                                                                                     |

## What a model sees

| Term              | Meaning                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Model call**    | One request to the LLM. A run makes many: reason, call a tool, read its result, reason again.                                                                                      |
| **Turn boundary** | The point between model calls where the engine can add new input to a running session.                                                                                             |
| **Context**       | Everything one model call receives: the system prompt, the tool definitions and the session's transcript.                                                                          |
| **System prompt** | Fixed instructions at the top of every model call of a session: the bot's persona and memory, the task goal, the team, the rules for its role and, for a child session, its brief. |
| **Transcript**    | A session's own history: its inputs, its replies, its tool calls and their outputs. It is private to the session and is sent in full with every model call.                        |
| **Push**          | The engine puts something into a session's context without the bot asking: its first input, and inbox items delivered at later turn boundaries.                                    |
| **Pull**          | The bot fetches something itself by calling a tool.                                                                                                                                |

## How work and information move

| Term             | Meaning                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inbox**        | A session's queue of incoming items. Each item is added to the session's transcript at its next turn boundary, or when it next runs.                                                                           |
| **Inbox item**   | One of four kinds: a **brief**, a **result**, **steering** or a **message**.                                                                                                                                   |
| **Brief**        | The assignment a child session starts from, written by the session that delegated it. It sits in the child's system prompt; the child starts on its **first input**, which may carry a handoff note.           |
| **First input**  | The inbox item a child session starts on, built by the engine when the delegation is made: an index of the task log so far, the user's messages, a handoff note when there is one, and a pointer to the brief. |
| **Report**       | A worker's final reply when it finishes its piece. It is delivered to its parent session as a **result**.                                                                                                      |
| **Steering**     | A user message in a task. It goes to the coordinator only.                                                                                                                                                     |
| **Message**      | Text one bot sends to a teammate, or to every active session in the task, with the `message` tool.                                                                                                             |
| **Wake**         | Start a new run of a waiting session. Briefs, results and steering wake a session; a message never does, and it waits for the recipient's next run.                                                            |
| **Task log**     | Every message of a task, stored once and in order: user messages, briefs, reports and teammate messages. The task chat in the UI shows it.                                                                     |
| **Workspace**    | The task's shared folder of files. Every session in the task reads and writes it through its coding tools.                                                                                                     |
| **Handoff note** | A note delivered with a brief when a bot gets more work from a session it reported to before: its last brief and report. It points to that work, rather than summarising it.                                   |
| **Task update**  | What a coordinator's direct chat is told when its task completes, fails or waits for the user: the input of one chat reply, which the bot writes in its own words.                                             |

## Settings and records

| Term                  | Meaning                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Goal version**      | A number that increases each time a task's goal or acceptance criteria change. Work done for an older version cannot complete the task.                 |
| **Verification plan** | The user's acceptance criteria for a task: commands, file assertions and result assertions. A task with one completes only when every criterion passes. |
| **Check**             | One criterion of a verification plan evaluated once, at one **gate attempt** of one goal version, with its outcome and evidence.                        |
| **Runtime profile**   | Settings that decide how a bot executes: its sandbox driver and limits, its coding tools and its budgets.                                               |
| **Sandbox**           | Where agent commands and file access run, provided by a sandbox driver (`local` or `docker`). A task's sessions share one sandbox.                      |
| **Artifact**          | A workspace file or a spilled tool output, stored with the task.                                                                                        |
