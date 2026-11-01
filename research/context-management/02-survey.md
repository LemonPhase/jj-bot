# Context management and inter-agent communication: a sourced survey for JJ Bot

Prepared 2026-11-01. Scope: the eleven approaches requested, each with (a) mechanism, (b) what it gets right, (c) costs and failure modes, (d) primary sources.

## How this was verified (read first)

This session's network allowed only `anthropic.com`, `claude.com`, `code.claude.com`, `platform.claude.com` and `github.com` (git clone). Everything else timed out or failed to resolve, including `arxiv.org`, `cognition.ai`/`cognition.com`, `manus.im`, `openai.github.io`, `microsoft.github.io`, `docs.letta.com`, `openreview.net` and the ICLR/NeurIPS proceedings. Every claim carries one of three evidence tags:

- **[opened]**: I fetched and read the page myself.
- **[repo]**: I read the official GitHub repository's docs or source at HEAD, which is often more current than the published docs site.
- **[search]**: The claim comes from search-engine result text or abstract snippets. I could not open the primary page. The URL is the primary source to check, but I have not read it.

Numbers tagged [search] should be checked against the PDF before you rely on them.

---

## 1. Anthropic multi-agent research system (June 13, 2025)

**(a) Mechanism.** This is an orchestrator-worker design. A lead agent (Claude Opus 4 in the evaluation) plans the research and spawns subagents (Sonnet 4). Each subagent searches in parallel in its own context window and returns condensed findings. The lead synthesizes these and decides whether more research is needed. Context reaches subagents only through the lead's delegation brief. The post says each brief needs "an objective, an output format, guidance on tools and sources, and clear task boundaries." Subagents can write large outputs to external storage ("Subagent output to a filesystem to minimize the 'game of telephone'"; "implement artifact systems where specialized agents can create outputs that persist independently") and pass lightweight references back. The lead "begins by thinking through the approach and saving its plan to Memory to persist the context," because a window beyond 200,000 tokens "will be truncated." [opened]

**(b) What it gets right.**
- The lead's context stays clean because subagents compress their results.
- Parallel breadth-first search makes it fast: up to 90% less research time on complex queries. [opened]
- Effort is scaled explicitly: 1 agent with 3–10 tool calls for simple fact-finding, 2–4 subagents with 10–15 calls for comparisons, and more than 10 subagents for complex research. [opened]
- It is engineered for long-running statefulness: "Agents are stateful and errors compound," so the team built resumption "from where the agent was when the errors occurred" and uses rainbow deployments so running agents are not disrupted. [opened]

**(c) Costs and failure modes.**
- Token cost: agents use "about 4× more tokens than chat interactions," and multi-agent systems "about 15× more tokens than chats." [opened]
- On BrowseComp, three factors explained 95% of performance variance, and token usage alone explained 80%. The other two were the number of tool calls and model choice. [opened]
- The multi-agent setup "outperformed single-agent Claude Opus 4 by 90.2%" on Anthropic's internal research eval. [opened]
- Economics: the approach needs "tasks where the value of the task is high enough to pay for the increased performance." [opened]
- Failure modes seen in early versions [opened]:
  - spawning 50 subagents for simple queries
  - searching endlessly for sources that don't exist
  - subagents "distracting each other with excessive updates"
  - vague briefs causing duplicated work and gaps
- Execution is synchronous: the lead waits for each batch, can't steer subagents mid-flight, and subagents can't coordinate with each other. [opened]
- The post explicitly says the approach fits poorly for domains "that require all agents to share the same context." It also notes that "most coding tasks involve fewer truly parallelizable tasks than research" and that "LLM agents are not yet great at coordinating and delegating to other agents in real time." [opened]

**(d) Source:** https://www.anthropic.com/engineering/multi-agent-research-system

## 2. Claude Code subagents (current docs)

**(a) Mechanism.**
- "Each subagent runs in its own context window with a custom system prompt, specific tool access, and independent permissions." A new subagent "doesn't see your conversation history, the skills you've already invoked, or the files Claude has already read." It works only from the delegation message Claude writes. The exception is a fork, which inherits the parent conversation.
- Only the result returns. The docs say to use a subagent "when a side task would flood your main conversation with search results, logs, or file contents you won't reference again: the subagent does that work in its own context and returns only the summary."
- Nesting is allowed up to three levels by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`).
- Foreground subagents block the parent. Background subagents report back via "a completion notification in a later turn."
- Subagents can be resumed with `SendMessage` and "retain their full conversation history." Up to 20 can run concurrently by default (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).

[opened]

**(b) What it gets right.** Isolation is the default and inheriting context is opt-in (a fork). Tools, model and permissions are declared per subagent. The asynchronous mode delivers background results as a later-turn notification, which is close to JJ Bot's "result posted to the parent's inbox wakes it."

**(c) Costs and failure modes.**
- "Running many subagents that each return detailed results can consume significant context, and each subagent spends tokens of its own while it runs."
- "A subagent that isn't a fork starts fresh and may need time to gather context." The docs therefore recommend the main conversation for quick, targeted changes.
- Subagent requests "count toward the same usage limits as your main conversation."

No published numeric token multipliers are given. [opened]

**(d) Source:** https://code.claude.com/docs/en/sub-agents (redirected from docs.claude.com/en/docs/claude-code/sub-agents)

## 3. Anthropic context engineering, context editing and the memory tool

**(a) Mechanism.** The essay frames context as a finite "attention budget." It cites "context rot": as tokens grow, "the model's ability to accurately recall information from that context decreases." It describes five techniques [opened]:

- **Compaction.** Summarize a conversation that is nearing the window limit and restart the window with that summary. In Claude Code, the summary is kept along with the five most recently accessed files.
- **Tool-result clearing.** "One of the safest lightest touch forms of compaction."
- **Structured note-taking / agentic memory.** For example a `NOTES.md` file or a to-do list. In the Pokémon example, the agent keeps progress notes across thousands of steps and rereads them after context resets.
- **Just-in-time retrieval.** Keep lightweight identifiers such as paths, queries and links, and load the data with tools at runtime. A hybrid is common: Claude Code drops `CLAUDE.md` in up front and uses glob/grep just-in-time.
- **Sub-agent architectures.** Subagents may use "tens of thousands of tokens or more" exploring but return "a condensed, distilled summary... often 1,000-2,000 tokens."

The API exposes two of these as features (beta header `context-management-2025-06-27`) [opened]:
- **Context editing.** `clear_tool_uses_20250919` "automatically clears the oldest tool results in chronological order" and replaces them with placeholders. It is configured with `trigger` (default 100,000 input tokens), `keep` (default 3 tool uses), `clear_at_least`, `exclude_tools` and `clear_tool_inputs`. `clear_thinking_20251015` manages old thinking blocks.
- **Memory tool.** `memory_20250818` is a client-side file directory that Claude can create, read, update and delete in, and it persists across conversations. When context nears the clearing threshold, Claude gets a warning to save important information to memory first.
- **Server-side compaction.** `compact_20260112` is now the recommended primary strategy. Client-side SDK compaction is deprecated.

**(b) What it gets right.**
- It treats context as a curated working set rather than a log.
- Durable state is pushed into files the agent can reread.
- Cheap, safe pruning (tool outputs) comes before lossy summarization.
- Just-in-time loading keeps the up-front prompt small.

**(c) Costs and failure modes.**
- Compaction is lossy. The essay advises tuning a compaction prompt for recall first, then precision. [opened]
- Tool-result clearing "invalidates cached prompt prefixes when content is cleared," hence `clear_at_least`. Clearing thinking blocks also invalidates the cache at that point. [opened]
- Published numbers from the Sept 29, 2025 announcement [opened]:
  - memory tool plus context editing "improved performance by 39% over baseline" on an internal agentic-search eval
  - context editing alone gave 29%
  - in a 100-turn web-search eval, context editing let agents finish workflows that otherwise failed from context exhaustion, "while reducing token consumption by 84%"

**(d) Sources:**
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://platform.claude.com/docs/en/build-with-claude/context-editing
- https://claude.com/blog/context-management (redirect target of anthropic.com/news/context-management)

## 4. Anthropic Agent Skills: progressive disclosure (Oct 16, 2025)

**(a) Mechanism.** Disclosure happens in three tiers [opened]:
1. At startup, only each skill's `name` and `description` go into the system prompt, "just enough information for Claude to know when each skill should be used."
2. If a skill looks relevant, Claude reads the full `SKILL.md` into context.
3. Bundled files (for example `forms.md`) and scripts are read or executed only when needed. Scripts can run without their source being loaded into context.

Because a filesystem-equipped agent reads only what it needs, "the amount of context that can be bundled into a skill is effectively unbounded." [opened]

**(b) What it gets right.**
- Context cost scales with relevance, not with the size of the catalog.
- Deterministic work moves to code: "sorting a list via token generation is far more expensive than simply running a sorting algorithm." [opened]
- It is the same just-in-time principle as §3, packaged as a distribution format.

**(c) Costs and failure modes.**
- Selection depends on the quality of the one-line description. A poorly described skill is never loaded.
- Security: skills add instructions and code, so a malicious skill could exfiltrate data or trigger unintended actions. Anthropic recommends "installing skills only from trusted sources" and auditing scripts and network instructions. [opened]
- No token numbers are published in the post.

**(d) Source:** https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills

## 5. Cognition, "Don't Build Multi-Agents" (Walden Yan, June 12, 2025) and the April 2026 follow-up

I could not open cognition.ai or cognition.com from this session. Everything below is [search] and should be checked against the primary pages.

**(a) Mechanism / argument.**
- **Principle 1:** "Share context, and share full agent traces, not just individual messages."
- **Principle 2:** "Actions carry implicit decisions, and conflicting decisions carry bad results."
- **Flappy Bird illustration.** A task is split between two subagents. One builds a Mario-style background and the other a bird that doesn't match it, because neither saw the other's decisions.
- **Recommendation.** Use a single-threaded linear agent. For very long tasks, add a model that compresses history into key details, events and decisions, rather than parallel writers.

**Follow-up, "Multi-Agents: What's Actually Working" (April 22, 2026).** According to the search summaries:
- Multi-agent setups work today "when writes stay single-threaded and the additional agents contribute intelligence rather than actions."
- Most real deployments are read-only helpers, such as search, which "mostly resemble tool calls."
- A reviewer worked best when it did not share the coder's context beforehand.
- Making multi-agent feel as coherent as a single agent is called an open 2026 problem.

**(b) What it gets right.** It names the core risk for coding agents. Parallel writers in a shared workspace make silent, incompatible decisions about style, edge cases and interfaces. A summary brief cannot carry those decisions.

**(c) Costs and failure modes.**
- Full-trace sharing costs context and runs into the window limits and context rot of §3. Their answer is a compression model, which is itself lossy.
- A single-threaded design gives up parallel speed.
- The 2026 follow-up partly reverses the 2025 stance: a clean-context reviewer is preferable, and only writes need serializing.
- No token numbers are published, as far as I could verify.

**(d) Sources (not opened):**
- https://cognition.ai/blog/dont-build-multi-agents
- https://cognition.ai/blog/multi-agents-working (also listed as https://cognition.com/blog/multi-agents-working)

## 6. OpenAI Agents SDK handoffs and Swarm

**(a) Mechanism.**
- **Handoffs.** A handoff is exposed to the model as a tool (`transfer_to_<agent>`). "When a handoff occurs, it's as though the new agent takes over the conversation, and gets to see the entire previous conversation history." [repo]
- **`input_filter`.** This receives `HandoffInputData` (`input_history`, `pre_handoff_items`, `new_items`, `input_items`, `run_context`) and can rewrite what the next agent sees. A prebuilt `handoff_filters.remove_all_tools` strips tool calls. [repo]
- **Nested handoff history.** An opt-in beta (`nest_handoff_history`) compacts prior history into `<CONVERSATION HISTORY>` summary segments. `handoff_history_mapper` gives full control. [repo]
- **`input_type`.** Lets the model attach small structured metadata to a handoff, such as a reason or priority. [repo]
- **Agents as tools.** The SDK contrasts handoffs with `Agent.as_tool()`. With agents as tools, "a manager agent keeps control of the conversation and calls specialist agents." With handoffs, the specialist "becomes the active agent for the rest of the turn." [repo]
- **Swarm.** The predecessor is now marked "experimental, educational" and is replaced by the Agents SDK. It is stateless between calls, passes `messages` plus a shared `context_variables` dict, and on handoff "the `system` prompt will change, but the chat history will not." [repo]

**(b) What it gets right.**
- There is a clear dichotomy between transferring control with the transcript (handoffs) and calling a bounded worker with structured input (agents as tools).
- Filters make the history passed on an explicit, testable policy.
- The docs warn that nested history "does not redact sensitive data," and tell you to "treat the receiving agent and its model provider as recipients of the forwarded history." [repo]

**(c) Costs and failure modes.**
- By default, the full transcript, including every tool result, is passed to each new agent, so context grows with every hop.
- Filtering only `input_items` can leave excluded content in the generated summary. [repo]
- Server-managed conversations (`previous_response_id`, `conversation_id`) "do not support handoff input filters." [repo]
- Guardrails apply only to the first agent's input and the final agent's output. [repo]
- No published token-cost numbers.

**(d) Sources:**
- https://github.com/openai/openai-agents-python/blob/main/docs/handoffs.md
- https://github.com/openai/openai-agents-python/blob/main/docs/multi_agent.md
- https://github.com/openai/swarm
- Rendered docs (not reachable from this session): https://openai.github.io/openai-agents-python/handoffs/

## 7. AutoGen GroupChat / SelectorGroupChat and AG2

**(a) Mechanism.**
- **SelectorGroupChat.** This "implements a team where participants take turns broadcasting messages to all other members. A generative model... selects the next speaker based on the shared context." On each step, the model reads the conversation history plus participant names and descriptions, picks a speaker (no repeats by default; `allow_repeated_speaker`), and that speaker's reply is "broadcasted to all other participants." [repo]
- **Overrides.** `selector_func` and `candidate_func` override or narrow model selection. [repo]
- **Buffering.** In the source, each participant's container buffers broadcast messages (`_message_buffer`). It hands the whole buffer to the agent only when that agent is selected, then clears it. Messages accumulate between turns and are delivered on the next activation, which is close to JJ Bot's "messages ride along on the next turn." [repo]
- **Persistence.** "The conversation context is kept within the team and all participants" across tasks until `reset()`. [repo]
- **Status.** AutoGen is now archived and in maintenance mode, and Microsoft points new users to Microsoft Agent Framework. [repo]
- **AG2.** AG2 v1.0 replaced the classic `GroupChat` with a "Network": a `Hub` that "owns the registry, the write-ahead log, and the audit trail," with agents talking over typed channels (`conversation`, `consulting`, `discussion`, `workflow`). It also adds opt-in `compact=` and `knowledge=` harness primitives. Classic `GroupChat` survives as "AG2 Classic." [repo]

**(b) What it gets right.** Everyone sees everything, so there are no information gaps of the kind Cognition describes. Dynamic speaker selection is simple to build. AG2's hub, write-ahead log and typed channels are a strong argument for explicit, auditable message channels over one undifferentiated thread.

**(c) Costs and failure modes.**
- Broadcasting means every agent's context grows with every other agent's output. The selector makes one more LLM call per turn over the shared history, and the default `UnboundedChatCompletionContext` never truncates. [repo]
- I found no official per-turn token numbers.
- The MAST study (§11) drew traces from AG2, among other frameworks. Its modes such as "Step Repetition," "Unaware of Termination Conditions" and "Task Derailment" are typical of free-form group chat. [repo]
- The AutoGen docs themselves cap the example at `MaxMessageTermination(25)` "to avoid infinite loop." [repo]

**(d) Sources:**
- https://github.com/microsoft/autogen (`python/docs/src/user-guide/agentchat-user-guide/selector-group-chat.ipynb`, `.../teams/_group_chat/_chat_agent_container.py`, `.../_selector_group_chat.py`, README)
- https://github.com/ag2ai/ag2 (README)
- Rendered docs (not reachable): https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html

## 8. MetaGPT: shared message pool with publish/subscribe and SOP documents

**(a) Mechanism.**
- **Philosophy.** MetaGPT models a software company (PM, architect, project manager, engineer) under the slogan "`Code = SOP(Team)`." [repo]
- **Message routing.** In the source, a `Message` carries `cause_by` (the action type that produced it), `sent_from` and `send_to`, which defaults to everyone. `Environment.publish_message` routes each message to every role whose address set matches (`is_send_to`). [repo]
- **Subscriptions.** Each role `_watch`es a set of action types. Its `_observe()` keeps only buffered messages where `n.cause_by in self.rc.watch or self.name in n.send_to`. Subscription is therefore by upstream action type, with direct addressing as an override. [repo]
- **Structured artifacts.** Roles exchange documents (PRDs, designs, interface specs), not chat. According to the paper, "roles such as Architect and Engineer often need to reference PRDs," so a shared pool lets any agent retrieve them without asking others. [search]

**(b) What it gets right.**
- Subscriptions filter what each role sees, which avoids AutoGen-style broadcast bloat.
- Structured intermediate documents reduce the "game of telephone" and make handoffs checkable.
- Executable feedback (running code) gives grounded verification. The paper reports 85.9% Pass@1 on HumanEval and 87.7% on MBPP, with executable feedback contributing about +4.2 and +5.4 points. [search; unverified against the PDF]

**(c) Costs and failure modes.**
- The SOP is a fixed waterfall, so tasks that don't fit the pipeline fit badly.
- Subscriptions by action type are static, so a role can miss a relevant message caused by an action it doesn't watch.
- Document-heavy pipelines spend tokens regenerating large artifacts.
- I could not verify the cost tables in the paper.

**(d) Sources:**
- https://github.com/geekan/MetaGPT (`metagpt/environment/base_env.py`, `metagpt/roles/role.py`, `metagpt/schema.py`, README) [repo]
- Paper, not opened: https://arxiv.org/abs/2308.00352

## 9. Blackboard architectures

**(a) Mechanism.**
- **Classic, Hearsay-II.** Erman, Hayes-Roth, Lesser and Reddy, _Computing Surveys_ 12(2):213–253, June 1980. Independent knowledge sources read from and write hypotheses to a shared, multi-level blackboard. A scheduler or focus-of-control mechanism decides which knowledge source to activate next, allocating limited processing to the most promising steps. Knowledge sources do not talk to each other directly. [search]
- **bMAS / LbMAS.** Han and Zhang, arXiv 2507.01701, July 2025. It has a control unit, a blackboard and role-specific LLM agents. The control unit iteratively selects agents to contribute to the blackboard until a stop condition is met, and LbMAS adds agent generation. [search]
- **Salemi et al.** "LLM-Based Multi-Agent Blackboard System for Information Discovery in Data Science," arXiv 2510.01285, Sept 2025, with a Google Research listing. A central agent posts requests to a blackboard. Subordinate agents, each covering part of a data lake, decide for themselves whether to respond. The paper contrasts this with rigid master-slave designs. [search]

**(b) What it gets right.**
- Agents are decoupled: they share state, not transcripts.
- Contributions are opportunistic: an agent responds only if it can help.
- Control is explicit and separate from content.
- This is the closest classic analogue to "shared state is workspace files plus explicit messages."

**(c) Costs and failure modes.**
- The scheduler/control unit becomes the critical component, and an LLM control unit is another per-step model call.
- The blackboard can grow unboundedly and needs its own structure and compaction.
- Concurrent writes need conflict control.
- Reported numbers [search; unverified against the PDFs]:
  - bMAS reports "best average performance while spending fewer tokens" than static and dynamic MAS baselines. A third-party summary cites 72.6% on MATH at about 4.72M tokens, which I could not verify.
  - Salemi et al. report 13%–57% relative improvement in end-to-end success and up to 9% relative F1 gain for data discovery over the best baselines, on KramaBench and modified DSBench and DA-Code.

**(d) Sources (not opened):**
- https://arxiv.org/abs/2507.01701
- https://arxiv.org/abs/2510.01285
- https://research.google/pubs/blackboard-multi-agent-systems-for-information-discovery-in-data-science/
- Hearsay-II: https://ijcai.org/proceedings/1977/191 (1977 retrospective) and the 1980 _Computing Surveys_ paper; no DOI opened

## 10. Letta / MemGPT hierarchical memory

**(a) Mechanism.** These details come from the retired V1 server source on the `archive` branch, which I read. The main branch says current development is in `letta-ai/letta-code`. [repo]

- **Core memory.** Labeled, size-limited memory blocks are always in context inside the system prompt. They can be read-only or read-write, and are edited with tools: `core_memory_append/replace`, `memory_replace`, `memory_insert`, `memory_rethink`, `memory_apply_patch`. [repo]
- **Recall memory.** Searchable past messages via `conversation_search`. [repo]
- **Archival memory.** An external store via `archival_memory_insert/search`. [repo]
- **Shared blocks.** Blocks attach to agents through a many-to-many `blocks_agents` table, so one block can be shared by several agents. [repo]
- **Multi-agent tools.** `send_message_to_agent_and_wait_for_reply`, `send_message_to_agent_async` (one-way notification) and `send_message_to_agents_matching_tags` (tag-addressed broadcast). [repo]
- **Sleep-time agents.** A group type runs a background "sleep-time" memory agent every N turns (`sleeptime_agent_frequency`). It reads recent messages and rewrites the primary agent's shared memory blocks. Its prompt says "You run in the background, organizing and maintaining the memories of an agent assistant." [repo]
- **Related paper.** "Sleep-time Compute" (Lin et al., arXiv 2504.13171, Apr 2025) reports [search]:
  - about 5× less test-time compute for the same accuracy on Stateful GSM-Symbolic and AIME
  - up to 13% more accuracy from scaling sleep-time compute
  - 2.5× lower average cost per query when the work is amortized over related queries
  - smaller benefit when queries are hard to predict from the context

**(b) What it gets right.**
- Memory tiers are explicit and agent-editable, separating what is always in context from what is retrieved on demand.
- Shared blocks give a small, curated, always-visible shared state, unlike full-transcript sharing.
- Background consolidation moves memory maintenance off the critical path.

**(c) Costs and failure modes.**
- Core memory costs tokens on every turn, so its size limits matter.
- Self-editing memory can drift, overwrite, or store relative dates. The sleep-time prompt explicitly warns against "today"/"recently."
- Shared blocks are a concurrent-write surface.
- Synchronous agent-to-agent calls block the caller.
- Sleep-time compute only pays off when future queries are predictable. [search]

**(d) Sources:**
- https://github.com/letta-ai/letta (README; `archive` branch: `letta/functions/function_sets/base.py`, `letta/functions/function_sets/multi_agent.py`, `letta/groups/sleeptime_multi_agent_v4.py`, `letta/prompts/system_prompts/sleeptime_v2.py`, `letta/orm/blocks_agents.py`)
- Not opened: https://arxiv.org/abs/2504.13171, https://docs.letta.com

## 11. Empirical studies and practitioner reports

### 11a. MAST: "Why Do Multi-Agent LLM Systems Fail?" (Cemri et al., 2025; NeurIPS 2025)

**(a) Content.** MAST is a taxonomy of 14 failure modes in 3 categories, whose names I read in the repository's `definitions.txt` [repo]:
- **1. Specification / system design:**
  - 1.1 disobey task specification
  - 1.2 disobey role specification
  - 1.3 step repetition
  - 1.4 loss of conversation history
  - 1.5 unaware of termination conditions
- **2. Inter-agent misalignment:**
  - 2.1 conversation reset
  - 2.2 fail to ask for clarification
  - 2.3 task derailment
  - 2.4 information withholding
  - 2.5 ignored other agent's input
  - 2.6 action-reasoning mismatch
- **3. Task verification:**
  - 3.1 premature termination
  - 3.2 weak verification
  - 3.3 no or incorrect verification

The taxonomy was built from 150 traces with inter-annotator kappa = 0.88. The released dataset has more than 1K annotated traces. [repo for the dataset; search for the kappa and the trace count]

**(b) Why it matters.** Most failures come from system design and coordination, not only from model capability. Verification is a category of its own.

**(c) Numbers.** Category shares disagree across secondary sources: roughly 42/37/21% versus 44/32/24%. I could not check the paper, so the exact percentages are **unverified**.

**(d) Sources:**
- https://github.com/multi-agent-systems-failure-taxonomy/MAST [repo]
- https://arxiv.org/abs/2503.13657 (not opened)

### 11b. AgentPrune: "Cut the Crap" (Zhang et al., ICLR 2025)

**(a) Content.** Multi-agent communication is modeled as a spatial-temporal message graph. One-shot pruning with a trainable graph mask removes redundant or malicious messages. The repo shows integrations with AutoGen (RoundRobinGroupChat mode) and GPTSwarm. [repo]

**(c) Numbers.** The abstract reports results comparable to state-of-the-art topologies "at merely $5.6 cost compared to their $43.7" on MMLU. [search, abstract text]

**(d) Sources:**
- https://github.com/yanweiyue/AgentPrune [repo]
- https://arxiv.org/abs/2410.02506 and https://openreview.net/forum?id=LkzuPorQ5L (not opened)

### 11c. Debate token cost

- **S²-MAD** (arXiv 2502.04790, NAACL 2025) reports [search]:
  - up to 94.5% token reduction versus standard multi-agent debate
  - 90.2% versus MAD-Sparse
  - 87.0% versus group debate
  - 81.7% versus CoT-SC
  - less than 2.0% accuracy loss
  - mechanism: agents drop redundant responses detected by regex or embedding similarity
- **Sparse communication topology** (arXiv 2406.11776) concludes that sparse debate matches or beats fully connected debate at much lower cost. I could not see its exact figures. [search]
- Takeaway: dense all-to-all communication is mostly redundant, and selective routing recovers most of the value.

### 11d. Manus, "Context Engineering for AI Agents: Lessons from Building Manus" (Yichao "Peak" Ji, July 18, 2025)

I could not open this page. All points are [search].

**Lessons:**
- **KV-cache.** The KV-cache hit rate is the key production metric, with an average input-to-output ratio of about 100:1.
  - Keep the prompt prefix stable: one changed token invalidates the cache from that point on.
  - Keep context append-only.
  - Use deterministic JSON serialization.
- **"Mask, don't remove" tools.** Constrain action selection through logit masking instead of changing tool definitions mid-loop.
- **"Use the file system as context."** The file system is "unlimited in size, persistent by nature, and directly operable by the agent." Compression stays restorable because you keep the path or URL.
- **Recitation via `todo.md`.** "By constantly rewriting the todo list, Manus is reciting its objectives into the end of the context."
- **"Keep the wrong stuff in."** Leave failed actions and stack traces in context so the model updates away from them.
- A companion post on X adds that context engineering can overfit to today's model limitations.

**Source (not opened):** https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus

---

## Cross-cutting synthesis for JJ Bot's design

I reached these from the sources above. They are proposals, not established findings.

1. **The isolated, brief-driven child session is the mainstream pattern,** but it is costly.
   - Anthropic's research system and Claude Code subagents both isolate context and return summaries.
   - Expect a token multiplier on the order of Anthropic's reported 15× over chat, and budget for it.
   - Effort-scaling rules in the coordinator's prompt are the documented mitigation for over-spawning.
2. **The brief is the weakest link** (Cognition; Anthropic's "vague delegation"; MAST 1.1, 2.2 and 2.4).
   - A structured brief would help: objective, output format, boundaries, relevant paths, and the decisions already made.
   - So would a workspace decision log (an `ADR.md` or `NOTES.md` in the sandbox). It carries implicit decisions that a summary drops, and children can load it just-in-time.
3. **Return references, not payloads.** Anthropic's filesystem artifacts and Manus's "file system as context" support children writing results to workspace files and posting a short result plus paths to the parent's inbox. That fits the 1,000–2,000-token return guidance.
4. **Non-waking, ride-along messages are well supported.**
   - Anthropic saw subagents "distracting each other with excessive updates."
   - AutoGen's container already buffers broadcasts until the agent next speaks.
   - AgentPrune and S²-MAD show most inter-agent messages are redundant.
   - Broadcasts should be capped and preferably typed or subscribed (MetaGPT-style by kind, AG2-style channels), so the next turn isn't flooded.
5. **Concurrent writers to the shared workspace are the main hazard** (Cognition 2025 and 2026; Anthropic's warning that coding is less parallelizable). Options:
   - serialize writes per file or area
   - give children read-only roles by default
   - use per-child worktrees merged by the coordinator
6. **Per-session context hygiene.**
   - Clear tool results before summarizing, with an eye on cache-prefix invalidation (Anthropic's `clear_at_least`, Manus's KV-cache lessons).
   - Keep the persona and system prefix stable and the transcript append-only.
   - Keep a `todo`/plan file the session rereads (Anthropic's Memory step, Manus's recitation).
7. **Verification needs its own reviewer.** MAST's task-verification category and Cognition's finding that clean-context reviewers work best both argue for a separate session for opt-in verification, one that does not inherit the worker's transcript.

---

## References

**Opened directly:**
- Anthropic, "How we built our multi-agent research system" (Jun 13, 2025): https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic, "Effective context engineering for AI agents": https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic, "Equipping agents for the real world with Agent Skills" (Oct 16, 2025): https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
- Claude Code docs, Subagents: https://code.claude.com/docs/en/sub-agents
- Claude API docs, Context editing: https://platform.claude.com/docs/en/build-with-claude/context-editing
- Claude blog, "Managing context on the Claude Developer Platform" (Sep 29, 2025): https://claude.com/blog/context-management

**Read from GitHub repositories (docs and source at HEAD):**
- https://github.com/openai/openai-agents-python (`docs/handoffs.md`, `docs/multi_agent.md`)
- https://github.com/openai/swarm
- https://github.com/microsoft/autogen (SelectorGroupChat notebook and source; README)
- https://github.com/ag2ai/ag2 (README)
- https://github.com/geekan/MetaGPT (`base_env.py`, `role.py`, `schema.py`, README)
- https://github.com/letta-ai/letta (README; `archive` branch source)
- https://github.com/multi-agent-systems-failure-taxonomy/MAST (README, `taxonomy_definitions_examples/definitions.txt`)
- https://github.com/yanweiyue/AgentPrune (README)

**Primary sources not reachable from this session (claims from search snippets; verify before quoting):**
- Cognition, "Don't Build Multi-Agents": https://cognition.ai/blog/dont-build-multi-agents
- Cognition, "Multi-Agents: What's Actually Working": https://cognition.ai/blog/multi-agents-working
- Manus, "Context Engineering for AI Agents: Lessons from Building Manus": https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Cemri et al., "Why Do Multi-Agent LLM Systems Fail?": https://arxiv.org/abs/2503.13657
- Zhang et al., "Cut the Crap" (AgentPrune): https://arxiv.org/abs/2410.02506
- Hong et al., MetaGPT: https://arxiv.org/abs/2308.00352
- Han & Zhang, bMAS: https://arxiv.org/abs/2507.01701
- Salemi et al., LLM-based multi-agent blackboard: https://arxiv.org/abs/2510.01285
- Lin et al., "Sleep-time Compute": https://arxiv.org/abs/2504.13171
- S²-MAD: https://arxiv.org/abs/2502.04790 ; sparse-topology MAD: https://arxiv.org/abs/2406.11776
- Hearsay-II retrospective: https://ijcai.org/proceedings/1977/191 ; Erman et al., _Computing Surveys_ 12(2):213–253 (1980)
- OpenAI Agents SDK rendered docs: https://openai.github.io/openai-agents-python/handoffs/
- AutoGen rendered docs: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/selector-group-chat.html
