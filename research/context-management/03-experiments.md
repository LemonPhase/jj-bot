# Proposed experiments

Each experiment runs through `harness.ts`, which boots the real engine, records every model request, and reads usage and cost from the `usage` table. Success is checked by a script over the final workspace, never by the model's own report.

Prices are pi's registry entry for `openai/gpt-6-luna`: $0.10 per million input tokens, $0.01 per million cached input tokens and $0.50 per million output tokens. Estimates assume 3 repeats per variant, because real models vary from run to run.

## E0. Calibration: one real-model baseline (needs approval, about $0.02)

Run the `baseline` and `followups` scenarios once each on gpt-6-luna. This replaces the scripted lower bounds in `01-today.md` with real transcript growth, tool-result sizes, cache hit rate and the cost of each session. Every later estimate is scaled from it.

## E1. Push vs pull: how a worker gets task context (about $0.30–0.60)

The question is whether workers should receive more context up front, or pull it with tools.

**Scenario.** The coordinator first inspects a small seeded repo. The user then sends a steering constraint, for example "use British spelling; do not touch `legacy/`". The coordinator delegates two pieces, and the second needs a fact that only the first worker's result contains.

**Variants.**

- **A. Today.** The brief only. The coordinator must relay everything.
- **B. Push.** The engine appends a task digest to each brief: the goal, the user's messages verbatim, and the results so far, clipped.
- **C. Pull.** The brief only, plus read-only tools: `task_log` (list or search the task's messages and results) and `read_report` (a session's result or brief).

**Metrics.**

- Success: the checker verifies the constraint was honoured and the cross-piece fact was used.
- Input and output tokens, cost, wall time.
- How many retrieval calls the workers made (C), and how many relay words the coordinator wrote (A).

**What would discriminate.** If B equals C on success at lower cost, pushing a small digest is enough. If C succeeds where A and B miss facts, pull is worth its tool overhead. If A matches both, relaying is fine and the gap is only a prompt problem.

## E2. A fresh child per delegation vs resuming the bot's session (about $0.20–0.40)

**Scenario.** The `followups` scenario. After the first result, the user asks for edits to one worker's file twice.

**Variants.**

- **A. Today.** Each follow-up delegation starts a fresh session.
- **B. Resume.** `delegate` to a bot that already has a completed session in this task appends the new brief to that session, which reopens.
- **C. Fresh + handoff note.** A fresh session whose brief is prefixed with the bot's own previous brief and report.

**Metrics.** Follow-up success: existing facts kept and the edit applied. Also tokens per follow-up, files re-read (count of `read` and `cat` calls on files already read), and wall time.

**What would discriminate.** Resume (B) pays for a growing transcript; C pays only for a short note. If C equals B on success, the cheap handoff note wins and compaction (#62) covers the rest.

## E3. Coordination channel between workers (about $0.30–0.50)

**Scenario.** Two workers must agree on an interface. One writes `lib.ts` exporting a function, the other writes `main.ts` calling it. Delegated in parallel; the coordinator is told not to dictate the signature.

**Variants.**

- **A. `message`.** Addressed or broadcast, as today; messages do not wake.
- **B. Blackboard file.** No `message` tool. Workers are told to record decisions in `.jj/notes.md` in the workspace and to read it before deciding.
- **C. Hub.** No peer channel. Workers report back and the coordinator reconciles them, for example by re-delegating a fix.

**Metrics.** Integration success (`tsc` passes on both files). Also tokens, the number of messages and how many arrived after the reader had already decided, how many re-delegations, and wall time.

**What would discriminate.** This shows whether non-waking messages arrive too late to matter, as we suspect, whether a shared file does the same job at lower cost, and whether hub-and-spoke is simply cheaper.

## E4. Context policies offline (free, scripted or replayed)

Replay the real transcripts from E0–E2 through a token calculator under several policies:

- full replay (today);
- clearing tool results older than K turns, keeping a stub with an artifact reference;
- compaction at X% of the context window (#62's trigger);
- a re-sent system prefix vs a cached one.

Metric: total input tokens and cost. This needs no model calls. It sizes the gain of tool-result clearing against compaction before either is built.

## Budget

| Item      | Estimate                                    |
| --------- | ------------------------------------------- |
| E0        | ~$0.02                                      |
| E1        | $0.30–0.60                                  |
| E2        | $0.20–0.40                                  |
| E3        | $0.30–0.50                                  |
| E4        | $0                                          |
| **Total** | **~$0.8–1.5**, within the $3 session budget |

Each variant needs a small, flag-guarded prototype on this research branch, either tools or a brief digest. None of it goes to `main`.
