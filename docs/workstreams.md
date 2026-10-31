# Next workstreams

Claim these tasks in Notion before starting; human owners remain unassigned. Notion owns live status, dependencies, acceptance checks and handoffs.

| Notion task                                                                                                                                   | Coordination                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| [01 · Finalize shared task, session and event contracts](https://app.notion.com/p/40af13214201818c98dcdf487628d1e4?pvs=204)                   | Agree these first              |
| [02 · Implement persistence and durable job scheduling](https://app.notion.com/p/40af132142018135916cc426891a0d27?pvs=204)                    | Coordinate schema with 01      |
| [03 · Build direct Gemini session executor and governed tools](https://app.notion.com/p/40af1321420181d18853fd36f26d4288?pvs=204)             | Needs contracts/model access   |
| [04 · Implement coordinator, delegation, steering and task stop](https://app.notion.com/p/40af13214201810cb13bca1c99465373?pvs=204)           | Needs storage/executor         |
| [05 · Build bot and task chat interfaces with CopilotKit OSS](https://app.notion.com/p/40af13214201815a9f0df4e740a094ec?pvs=204)              | Can start with agreed fixtures |
| [06 · Build task collaboration and verification visualization](https://app.notion.com/p/40af132142018111bdafcaeef61a3ac3?pvs=204)             | Can start with agreed fixtures |
| [07 · Implement task/session verification and integrated completion gates](https://app.notion.com/p/40af1321420181a7a309f2354cdeafcf?pvs=204) | Needs executor/coordinator     |
| [08 · Review dependency advisories and frontend bundle size](https://app.notion.com/p/40af1321420181359ed1d3a491675ba3?pvs=204)               | Before external deployment     |

Reuse existing Notion tasks for [model access](https://app.notion.com/p/40af13214201818a9a34f04339588c6a), [demo scope](https://app.notion.com/p/40af13214201819a9d22f26f2e3c6e7e), and [end-to-end integration](https://app.notion.com/p/40af1321420181fab761fa6ea37de9bb). Do not create duplicate tracks for these.

Agree shared contracts first. Persistence, model access, chat and visualization can then progress independently using reviewed interfaces/fixtures. Coordinate shared App.tsx/styles, contract files and root dependencies. Runtime, coordinator and verification must converge on the multi-bot milestone.

For the current iteration, lint and tests are the required baseline. Add targeted acceptance checks as substantive behavior is implemented; avoid building an exhaustive verification system during scaffolding. See [CONTRIBUTING.md](../CONTRIBUTING.md).
