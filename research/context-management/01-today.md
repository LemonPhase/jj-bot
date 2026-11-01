# How context and messaging work today

Issue #68, part 1. Code references are to `main` at 428d945. Measurements come from the harness in this directory (`harness.ts`, `scenarios.ts`), which boots the real engine in-process with the scripted model and records every model request.

## 1. What each model call sees

### Task sessions (coordinator and workers)

A run is one `executor.run` call built in `prepare` (`packages/backend/src/worker/session-run.ts:282-341`). Each model request in that run carries, in order:

| Part | Source | Notes |
| --- | --- | --- |
| System prompt | `sessionPrompt` (`worker/prompts.ts:66-127`) | Persona and instructions, the bot's memory note (`prompts.ts:41-55`), the goal **with its version number**, the roster, the workspace path, and role rules. Rebuilt on every executor call (`session-run.ts:312`). |
| Tool declarations | coding tools from the bot's profile plus collaboration tools (`worker/collab-tools.ts:363-376`) | Folded into the leading system message by pi's `createInitialSystemMessage` (`runtime/src/loop.ts:436-443`). `delegate` and `message` embed the roster in their descriptions and enums; they are byte-stable across a session's runs on purpose (`collab-tools.ts:56-60`). |
| Transcript | every `session_entries` row of this session (`worker/run-context.ts:117-127`, loaded at `session-run.ts:324`) | The whole pi transcript: user inputs, assistant messages, every tool call and tool result. Repaired, never trimmed (`runtime/src/transcript.ts:215-244`). There is no compaction or tool-result clearing (#62 is in flight). |
| New inputs | undelivered inbox items (`run-context.ts:146-192`) | Each item becomes a separate user message (`runtime/src/executor.ts:57-59`). Mid-run, `getSteeringMessages` drains the inbox again at every turn boundary (`loop.ts:432`, `run-context.ts:341`). |

A worker's first input is its brief, `Assignment from <coordinator>:\n<brief>` (`collab-tools.ts:175-184`). It sees **nothing else from the task**: not the user's messages, not the coordinator's reasoning, not sibling results. The coordinator sees the user's goal and steering, and each result as it arrives.

Tool output that reaches the model is capped at 64 KiB per call (`TOOL_OUTPUT_PREVIEW_LIMIT`, `contracts/src/events.ts:33`; `runtime/src/executor.ts:26-34`). Larger output is spilled to an artifact and the model gets the head plus a reference. 64 KiB is roughly 16k tokens, and every capped result stays in the transcript for the rest of the session.

### Direct chat

`runChatJob` (`worker/chat-reply.ts:50-165`) makes a fresh, stateless pi loop per reply (`runtime/src/chat.ts:78-177`):

- System prompt `chatPrompt` (`prompts.ts:142-170`): persona, memory, the bot's **unfinished** tasks (id, title, status), and the team.
- History: the last 40 conversation messages (`config.chatHistoryLimit`, `services/chat.ts:113-125`), **text only**. Earlier tool calls are not replayed (`runtime/src/chat.ts:100-104`).
- Tools: `create_task`, and `send_to_task` only while the bot has unfinished tasks (`chat-reply.ts:83-87`).

"Unfinished" comes from `presenceOf`, which drops `completed`, `failed` and `cancelled` tasks (`services/bots.ts:60-72`; `FINISHED_TASK_STATUSES`, `contracts/src/tasks.ts:32`). So when a task finishes it disappears from the chat prompt and from `send_to_task`'s enum. Each conversation message records the `taskId` it created or forwarded to (`chat-reply.ts:124`), but nothing reads that link back into a prompt, and the task's result is never posted into the conversation.

## 2. What wakes a session

All input goes through `deliver` (`services/messages.ts:139-173`), which inserts an inbox row and then:

| Input | Kind | Wakes? | Where |
| --- | --- | --- | --- |
| Brief for a new child session | `brief` | yes | `collab-tools.ts:175-184` |
| Worker result or failure for the parent | `result` | yes | `outcomes.ts:280-289`, `outcomes.ts:98-107` |
| User steering, coordinator only | `steering` | yes | `messages.ts:306-311` |
| Chat relay (`send_to_task`), coordinator only | `steering` | yes | `chat-reply.ts:355-364` |
| Teammate `message`, addressed or broadcast | `message` | **no** | `collab-tools.ts:251-261`, `285-294` |

- **Waking** enqueues a `session.run` job. If the session is running, a `jj_control` notify makes it drain at its next turn boundary (`messages.ts:156-171`).
- **Messages** ride along on whatever run happens next. `hasContinuingInput` counts only briefs, results and steering (`worker/runs.ts:150-166`), and a coalesced wake that finds only messages is skipped (`session-run.ts:139-158`). Undelivered messages are capped at 20 per session; older ones collapse into one `[N earlier messages omitted]` line (`messages.ts:82-130`).
- **One job keeps going while input arrives.** After the model ends its turn, the job takes continuing input and calls the executor again, up to 20 times (`session-run.ts:385-403`). `finishRun` re-checks under the task lock (`outcomes.ts:401-409`).
- **Who can receive a message.** An addressed message goes to the recipient bot's newest active session on the task (`collab-tools.ts:269-280`). If that bot has finished its session, or never had one, the message is posted to the task chat but reaches no model (`collab-tools.ts:281-284`). A finished session's inbox is write-only (`messages.ts:155`).

## 3. How results and messages flow

```
user ─steering─▶ coordinator ──delegate(brief)──▶ worker (fresh session, brief only)
     ▲                ▲                                │
     │ task chat      └──── result (final text) ◀──────┘   wakes the parent
     │ (UI view only)        + "open delegations" list
     └── complete_task(result) ── task.result, a result message in the task chat
```

- **A worker's result is its last assistant text** (`outcomes.ts:252-289`). It is stored on the session, posted as a `result` message, and delivered to the parent as `Result from X (session …):\n<text>\n\n<open delegations>`. It is not size-limited, and it stays in the parent's transcript permanently.
- **The coordinator finishes** with `complete_task(result)` (`collab-tools.ts:301-355`). At end of turn, `endTurn` posts the result and completes the task (`outcomes.ts:184-225`).
- **The task group chat is a projection.** Every brief, result, message and steering is posted once (`messages.ts:46-78`) and shown in the UI. It is never replayed to a model as a whole; the architecture states that "no model call receives the whole task transcript" (`docs/architecture.md`, Context and memory).
- **Shared state** is the task workspace (one sandbox per task) and whatever bots copy into briefs, results and messages.
- **Re-delegation is cold.** A second `delegate` to the same bot creates a new session (`collab-tools.ts:146-160`). The bot's earlier session, including what it read and decided, is not reachable.
- **Follow-ups extend one transcript.** A follow-up reopens the task and appends to the coordinator's same transcript (`messages.ts:191-233`). The transcript grows without bound across follow-ups.

## 4. Token cost drivers, measured

Harness runs on the scripted model; tokens are estimated as characters ÷ 4 of exactly what pi hands the provider. The scripted model writes tiny files and short texts, so transcript growth here is a **lower bound**. A real model reads files and runs commands, which makes tool results much larger.

**Baseline**: one coordinator and two parallel workers, the `smoke:e2e` penguin task. 10 model calls, about 22k input tokens in total.

| Call | Session | System | Tool declarations | Transcript | Total |
| --- | --- | --- | --- | --- | --- |
| first | coordinator | ~480 | ~1,540 | ~70 | ~2,080 |
| last | coordinator | ~480 | ~1,540 | ~930 | ~2,950 |
| first | worker | ~300 | ~1,430 | ~110 | ~1,830 |
| last | worker | ~300 | ~1,430 | ~380 | ~2,100 |

**Follow-ups**: the baseline, then two user follow-ups on the finished task. The coordinator's per-call context grew 2.1k → 3.6k tokens, and its transcript grew from 10 to 16 entries. Nothing ever leaves it.

**Chat**: the user asks for the work, then asks "How did the penguin task go?" after it finishes. The finished task was no longer in the chat prompt, and `send_to_task` was gone. The reply created a **second task** instead of answering, which reproduces the first known gap in #68. The scripted model's rules force this choice. A real model would at least have had no data to answer from.

The cost drivers, in order:

1. **Fixed prefix per call.** About 2k tokens of system prompt plus tool schemas are re-sent on every call by every session. In the baseline that is 68–97% of each request. It is cacheable while byte-stable. The system prompt embeds the goal version and the roster, so a goal change or a roster change invalidates it.
2. **Full transcript replay.** Every call re-sends the whole session transcript, so total input grows roughly quadratically with turns. With real tools, one `cat` or test log can add up to about 16k tokens that stay for the rest of the session.
3. **Fan-out.** Each delegation pays its own prefix and then rediscovers the workspace: it re-reads files the coordinator may already have read, because nothing but the brief is passed. The real-model runs in experiment E1 will size this.
4. **Results and relayed text.** Worker results and messages have no size limit. They become permanent parent-transcript entries, and the open-delegations list is appended to every result.
5. **Broadcasts.** One broadcast becomes N inbox items, one per active session, each replayed in that session from then on.
6. **No reuse across sessions.** Re-delegation to the same bot, and follow-ups, cannot reuse a worker's earlier context, so work is either repeated or relayed through the coordinator.
