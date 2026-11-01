# Experiment results

Model: `openai/gpt-6-luna`. Each variant ran 5 times through `harness.ts`, with the prototypes enabled by `JJ_EXP_*` flags (`packages/backend/src/worker/experiments.ts`, research branch only). Pass/fail comes from a script that reads the final workspace, never from the bot's own report. Reproduce with `run-all.sh` and `run-e2.sh`, then `node analyze.cjs`.

**Spend:** $0.147 in total, including a discarded first E2 batch. The provider reported 99.9% of prompt tokens as cache reads. I have not verified that, so I also give the list price with no caching, which is $0.36 for all 3.2M prompt tokens.

**Caveat:** n = 5 per variant. A gap of one run (4/5 against 5/5) is noise. Only the token and cost differences, and E3's large gaps, are signal.

## E0. Calibration: a task plus two follow-ups

| | Mean of 5 |
| --- | --- |
| Prompt tokens | 84k |
| of which the coordinator | 65k (77%) |
| Model calls | 38 |
| Worker sessions | 5 (each follow-up starts a new one) |
| Cost | $0.0036 |
| Wall time | 42 s |

In a real run the coordinator's transcript grew steadily from about 70 to 3,600 tokens across 21 calls. Each worker session started near zero and stayed under about 550. **The coordinator is the cost centre.** Clearing old tool results and compaction (#62) pay off most on the root session.

## E1. Push vs pull: getting task context to a worker

The scenario has two parts:

- **A late user rule.** It is posted once Grace has already started: "end every definition with `[kiwi-7]`".
- **A sibling fact.** Linus must not repeat Grace's terms, which only her result tells him.

| Variant | Pass | Prompt tokens | of which workers | Calls | Cost |
| --- | --- | --- | --- | --- | --- |
| Today (brief only) | 4/5 | 47.6k | 14.5k | 24.4 | $0.0025 |
| Push (digest appended to the brief) | 5/5 | 45.1k | 11.7k | 22.8 | $0.0022 |
| Pull (`task_log`, `read_entry`, `read_report`) | 5/5 | 66.9k (+40%) | 21.9k | 29.6 | $0.0027 |

- **Today's single failure:** Grace's file lacked the late rule.
- **The coordinator relayed by itself.** In every variant it sent the rule with `message` about three times per run. On this model, relaying covers most of the gap.
- **Pull works.** Workers did use the tools: Linus called `task_log` about twice per run, and Grace about 0.8 times per run. But it costs about 40% more tokens.
- **Push was no more expensive than today.** A digest attached at brief time cannot reach a session that is already running, so the late rule still needed `message`.

**Reading:** push a short digest into every brief; it is cheap. Keep pull for what a brief cannot anticipate. Make pull tools available, not required. They are not needed for routine work on this model.

## E2. Re-delegation: fresh session vs resume vs handoff note

Round 1: Grace writes three terms and states an invented codeword only in her report. Follow-up: she adds a fourth term and a line with *the codeword she chose earlier*. The check compares that line with her round-1 report.

| Variant | Pass | Codeword right | Prompt tokens | Grace sessions | Cost |
| --- | --- | --- | --- | --- | --- |
| Fresh session (today) | 4/5 | 4/5 | 43.6k | 2 | $0.0020 |
| Handoff note (C2) | 4/5 | 4/5 | 30.9k (−29%) | 2 | $0.0016 |
| Resume old session (C1) | 4/5 | **5/5** | 35.5k (−19%) | 1 | $0.0016 |

- **The fresh-session failure:** Grace wrote `Codeword: glacier`, but her round-1 report said `Frostvale`. A cold session invented a new codeword, and **the coordinator then reported the update as done**.
- **The handoff-note failure:** Grace wrote `tavernox` instead of `wrenpika`. The cause is not determined, since the note did carry the report.
- **The resume failure:** right codeword, but Grace added two terms instead of one.
- **A discarded first batch** had a contradictory instruction ("never put the codeword in a file") and a brittle checker. It is kept in `results/superseded/` and excluded from the tables.

**Reading:** both warm variants cost 20–30% less than a fresh session. Success is the same within noise. The failure that matters is the silent one: a confident "done" with the wrong content. That supports opt-in verification, rather than any one re-delegation mode. C2 (the handoff note) is the cheap, low-risk choice. C1 is the only variant that never got the codeword wrong, but it needs reopen semantics.

## E3. How two workers agree on an interface

Grace writes `lib.ts`, which exports a formatter. Linus writes `main.ts`, which calls it. The check is that `node --experimental-strip-types main.ts` runs, and the coordinator may not edit the files itself.

| Variant | Pass | Prompt tokens | Calls | Wall time | Fix delegations | Bot messages |
| --- | --- | --- | --- | --- | --- | --- |
| Hub: coordinator fixes the interface in both briefs | 5/5 | **19.4k** | 12.2 | 11.7 s | 0 | 0 |
| Peers use `message` (today) | 5/5 | 59.6k (3.1×) | 29.8 | 18.5 s | 1.0 | 9.6 |
| Peers use `NOTES.md` (no `message`) | 5/5 | 98.4k (5.1×) | 48.4 | 24.0 s | 2.2 | 0 |

Each variant ended up working, but peer coordination cost 3–5× more and needed repair delegations. With `NOTES.md`, the workers read the file about 8 and 5 times per run while polling for each other's decisions, and still needed about 2 fixes per run.

**Reading:** when the coordinator can decide an interface, it should, and put it in both briefs. Peer-to-peer agreement is the expensive path. A shared notes file is worse than `message` when used for live negotiation. A decision log (option B) is still plausible as a *record* of decisions, but not as a negotiation channel.

## What this changes in the recommendation

1. **Hub-and-spoke with decisions made up front.** The coordinator's prompt should tell it to fix shared interfaces and conventions in the briefs. This is the cheapest and most reliable pattern measured.
2. **Option A, split in two.** A cheap pushed digest in every brief (user messages and results so far), plus pull tools kept for exceptions. Do not rely on pull for routine context.
3. **Option B is downgraded.** A notes file for negotiation was the most expensive variant. Revisit only as a record of decisions, if a need appears.
4. **C2 (handoff note) on re-delegation.** −29% tokens, no loss in success.
5. **Peer `message` stays, but de-emphasised.** It is useful for late changes (E1's relays), and costly as a design tool (E3).
6. **Cost work belongs on the coordinator's transcript** (E0: 77% of tokens), through #62 and tool-result clearing.
7. **Verification.** E2 showed confident "done" reports over wrong content. That is evidence for opt-in verification (docs/verification.md), not a new finding about context.
