# Fit with JJ Bot, and design options

Part 4 of the #68 research. It builds on `01-today.md` (the current mechanics and measurements) and `02-survey.md` (sources, each tagged opened, repo or search-only). Nothing here is decided; this is input for the owner.

## How each approach maps onto JJ Bot

| Approach                                                                               | What JJ Bot already has                                                                                                                                   | What it would add                                                                                                                                                                                                | Fit                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Orchestrator/worker** (Anthropic research system, Claude Code subagents)             | This is JJ Bot's model: a coordinator, delegated child sessions with isolated context, results returned as summaries, and an asynchronous wake on result. | Structured briefs (objective, output format, boundaries, decisions already made); effort-scaling rules; results that point to files instead of carrying payloads; resuming a worker (Claude Code `SendMessage`). | **Keep as the backbone.** The fixes go into the briefs and results, not the topology.                                                                                                      |
| **Handoffs** (OpenAI Agents SDK, Swarm)                                                | Nothing. JJ Bot never transfers control of a session.                                                                                                     | Moving a session to another bot along with its transcript, through an `input_filter`.                                                                                                                            | **Poor.** It conflicts with the single-coordinator model and the per-bot persona and memory. The useful lesson is the filter: what a receiver sees should be an explicit, testable policy. |
| **Group chat and selector** (AutoGen, AG2)                                             | The task chat is the shared thread, but only the UI renders it. Undelivered messages buffer until the next turn, as in AutoGen's per-agent buffer.        | Broadcasting every message to every agent, plus a speaker-selection model call.                                                                                                                                  | **Poor for the channel; good for the buffering semantics** JJ Bot already has. AG2 has itself moved from one thread to a hub with typed channels and a write-ahead log.                    |
| **Message pool with publish/subscribe** (MetaGPT)                                      | Message intents (discussion, assignment, result, steering, notification).                                                                                 | Sessions subscribe by intent or kind, so `task_log` is filtered by kind. Typed documents (specs and interfaces) instead of chat.                                                                                 | **Partial.** Use intents as retrieval filters, not push subscriptions.                                                                                                                     |
| **Blackboard**                                                                         | The workspace is a de facto blackboard, with files as shared state.                                                                                       | A structured, small, always-visible decision or notes surface; agents contribute when they can.                                                                                                                  | **Good, in a light form:** a decision log that every session can read and append to. It addresses the "actions carry implicit decisions" problem (Cognition) that briefs cannot carry.     |
| **Hierarchical memory** (Letta/MemGPT)                                                 | A bot's memory note is core memory the user edits. There is no recall or archival tier.                                                                   | A recall tier, meaning search over past messages and results, which is exactly the proposed task tools. Shared blocks. Background consolidation.                                                                 | **Good for recall.** Agent-written memory is #42 and stays out of scope.                                                                                                                   |
| **Context-engineering practice** (compaction, clearing, notes, just-in-time retrieval) | Nothing yet. #62 compaction is in flight.                                                                                                                 | Clearing old tool results first, then compaction; a `todo`/plan file; a stable prefix for the KV cache.                                                                                                          | **Required.** It is per-session hygiene, independent of the communication design. Clearing is the cheapest gain (Anthropic: −84% tokens on a 100-turn eval).                               |
| **Progressive disclosure via tools** (Skills)                                          | Nothing.                                                                                                                                                  | Short indexes in the prompt, with full content one tool call away.                                                                                                                                               | **Matches the owner's direction.** It applies to task history the way Skills apply to instructions.                                                                                        |

**Takeaway.** No source suggests replacing hub-and-spoke with peer messaging for coding work. The evidence runs the other way:

- Anthropic: subagents "distracting each other with excessive updates"; coding is less parallelisable than research.
- Cognition: keep writes single-threaded.
- AgentPrune and S²-MAD: most inter-agent messages are redundant.
- MAST: "information withholding" and "ignored other agent's input" are inter-agent failure modes in their own right.

Messages that do not wake a session are the right default. What JJ Bot lacks is shared, retrievable context and a place to record decisions; it does not need more messaging.

## Is bot-to-bot messaging efficient today? (owner's question 2)

Mechanically it is cheap, because a message is one inbox row, but it is low-value and error-prone:

- **Messages may arrive too late.** A worker reads a message only at its next turn boundary, and a waiting session reads it only when something else wakes it. A peer that has already decided never sees it.
- **Messages to finished sessions are lost silently.** If the recipient's session has finished, the message reaches no model. The tool result does say so for an addressed message, but a broadcast simply skips finished sessions.
- **Broadcasts multiply cost.** One broadcast is copied into N transcripts and replayed on every call after that.
- **Peers cannot reach each other's history.** Without reading a peer's report, a bot can only ask the peer, which costs a turn on both sides.

E3 measures this against a shared decision log and against the coordinator acting as hub.

## Design options

### Option A: hub-and-spoke with progressive-disclosure task context (recommended baseline)

Keep the coordinator, delegation, results and the inbox. Add:

1. **Read-only task-context tools**, available to every session in the task:
   - `task_log(query?, kind?, from?, limit)`: list or search the task's messages, briefs, results and steering. The results are short entries with ids.
   - `read_entry(id)`: the full text of one entry.
   - `read_report(session)`: a session's brief, status and result. This is the "read another session's report" candidate.

   Transcripts stay private: reports, not reasoning. Only the coordinator's prompt carries a short index of the task, such as counts and the latest user message.
2. **Structured briefs and pointer results.** The `delegate` schema gains optional `files` and `report` fields. Worker prompts ask for a short report that points to the files written. The result delivered to the parent is clipped to N tokens, with the full text available through `read_report`.
3. **The user's words reach workers on request.** `task_log(kind: steering)` replaces relaying by the coordinator.
4. **Message fixes.** Addressing a finished session returns a tool error that suggests `delegate`. Broadcasts are capped or removed, depending on E3.

- **Pros:** a small change on the existing records; the prompt stays small; it matches the owner's progressive-disclosure direction and Anthropic's just-in-time practice; it is auditable.
- **Cons:** it depends on the model choosing to look things up (E1 measures this); each tool costs about 150–300 prefix tokens per call; facts that are never written down are still lost.

### Option B: A plus a shared decision log (blackboard-lite)

Option A, plus a task-level **decision log**. Any session appends short entries with `note(text, kind: decision|interface|todo|risk)`. The last K titles are listed in every session's input at each turn boundary, delivered like messages, and the full text is available through `task_log(kind: note)`. It replaces most of the peer `message` traffic.

- **Pros:** it makes implicit decisions explicit and shared, which is Cognition's main failure mode; it is cheaper than broadcast because only the index is pushed; it survives finished sessions.
- **Cons:** a new record type and contract change; agents must be prompted to use it; the index adds per-turn tokens; it competes with simply writing `NOTES.md` in the workspace, which needs no product change. E3 variant B checks whether the file convention alone is enough.

### Option C: A plus resumable per-bot sessions

Option A, plus re-delegation to a bot that has a finished session in the task. The engine either reopens that session with the new brief (C1), or starts a fresh session whose brief carries the bot's previous brief and report as a handoff note (C2).

- **Pros:** it fixes the cold re-delegation gap; C2 costs only a short note.
- **Cons:** C1 grows transcripts and leans on #62 compaction, it serialises a bot's pieces within one task (two parallel pieces for the same bot would need two sessions anyway), and it complicates the session tree and status rules. C2 is nearly free.

## Recommendation (proposal)

**Build A first, take C2 in with it, and let E3 decide on B.**

- **Why A:** it directly implements the owner's progressive-disclosure direction with the smallest contract change, and the parked `list_tasks`/`search_tasks` tools are the same tools at a wider scope (task → workspace), so they can follow later without redesign.
- **Why C2:** the cold re-delegation gap closes for a few hundred tokens.
- **Why wait on B:** if a `NOTES.md` convention does as well as `message` and as a structured log in E3, B is just a prompt change; otherwise it becomes its own issue.

Two independent hygiene items fall out of the measurements, separate from the options:

- **Stable prefix.** Keep the system prompt byte-stable within a session. Move the goal version and any roster change into inbox inputs rather than the system prompt, so the roughly 2k-token prefix stays cached. JJ Bot already does this for the tool definitions.
- **Tool-result clearing before compaction.** Coordinate with #62: replace old tool results with a stub plus an artifact reference, using pi's or the engine's own policy. E4 sizes the gain offline.

For the chat gap (finished tasks vanish from chat), the minimal fix is consistent with A:

- the chat prompt lists the last few finished tasks, with status and a one-line result;
- `send_to_task` accepts finished tasks, since continuation already allows it;
- a `read_task(id)` tool returns the task's result.

The broader task list and search tools stay parked, as the owner asked.
