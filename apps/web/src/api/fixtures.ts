/**
 * Demo fixtures ported from the workspace prototype. Shown only while the UI
 * runs on `createDemoApi()`, always under a visible "Demo data" label.
 */
import type { BotProfile, DirectMessage, TaskView } from "./types";

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

export function demoBots(): BotProfile[] {
  return [
    {
      id: "bot-juno",
      name: "Juno",
      role: "Coordinator · Systems Architect",
      color: "#E05A47",
      glyph: "visor",
      presence: "busy",
      instructions:
        "Decompose user goals into crisp execution briefs, assign specialist bots, and reconcile final results against verification criteria.",
      memory:
        "• Workspace uses Hono + Drizzle + Google GenAI SDK.\n• Prefer minimal diffs and explicit verification evidence.\n• Coordinate with Moss for runtime code and Vesper for QA checks.",
    },
    {
      id: "bot-kite",
      name: "Kite",
      role: "Research & Context Synthesis",
      color: "#2563EB",
      glyph: "radar",
      presence: "online",
      instructions:
        "Gather specification constraints, inspect API contracts, and distill findings into concise briefs for the team.",
      memory:
        "• Shared Zod schemas live in packages/contracts.\n• AG-UI client is pinned to 1.0.2.",
    },
    {
      id: "bot-moss",
      name: "Moss",
      role: "Runtime & Code Execution",
      color: "#10B981",
      glyph: "pixel",
      presence: "busy",
      instructions:
        "Implement clean TypeScript modules, run targeted checks, and report concrete command outputs.",
      memory:
        "• Always run lint and unit tests before marking a session ready.\n• Keep model keys server-side only.",
    },
    {
      id: "bot-vesper",
      name: "Vesper",
      role: "Verification & QA Gate",
      color: "#7C3AED",
      glyph: "prism",
      presence: "online",
      instructions:
        "Independently verify session outputs against task criteria. Never accept a claim without reproducible evidence.",
      memory:
        "• Passed outcomes require non-empty evidence.\n• Stale goal versions invalidate prior checks.",
    },
  ];
}

export function demoConversations(): Record<string, DirectMessage[]> {
  return {
    "bot-juno": [
      {
        id: "m1",
        botId: "bot-juno",
        role: "user",
        text: "Hey Juno, can we audit the SSE reconnect flow and make sure event replay doesn't drop messages?",
        createdAt: ago(9),
      },
      {
        id: "m2",
        botId: "bot-juno",
        role: "assistant",
        text: "On it. I spun up a task with Moss and Vesper so we can inspect the cursor handling and verify replay order.",
        createdAt: ago(8),
        taskId: "task-101",
      },
      {
        id: "m3",
        botId: "bot-juno",
        role: "user",
        text: "Keep the payload schema unchanged while doing that.",
        createdAt: ago(5),
      },
      {
        id: "m4",
        botId: "bot-juno",
        role: "assistant",
        text: "Noted — I updated the task constraints to v2 so Moss keeps the existing contract untouched.",
        createdAt: ago(5),
      },
    ],
    "bot-kite": [
      {
        id: "k1",
        botId: "bot-kite",
        role: "user",
        text: "Kite, summarize the contract differences between v0.1 and v0.2.",
        createdAt: ago(75),
      },
      {
        id: "k2",
        botId: "bot-kite",
        role: "assistant",
        text: "v0.2 added explicit goalVersion tracking on tasks, sessions, and verification results, plus replayCursor on task snapshots.",
        createdAt: ago(74),
        taskId: "task-102",
      },
    ],
    "bot-moss": [
      {
        id: "mo1",
        botId: "bot-moss",
        role: "user",
        text: "How is the session executor retry loop structured?",
        createdAt: ago(60 * 24),
      },
      {
        id: "mo2",
        botId: "bot-moss",
        role: "assistant",
        text: "Each session runs bounded attempts: execute -> run checks -> if failed and within budget, transition to session.revising with failure evidence.",
        createdAt: ago(60 * 24 - 1),
      },
    ],
    "bot-vesper": [
      {
        id: "v1",
        botId: "bot-vesper",
        role: "user",
        text: "What's our current verification pass rate?",
        createdAt: ago(60 * 23),
      },
      {
        id: "v2",
        botId: "bot-vesper",
        role: "assistant",
        text: "2 of 3 active tasks have full evidence coverage. Task #101 is currently verifying session s-2.",
        createdAt: ago(60 * 23 - 1),
        taskId: "task-101",
      },
    ],
  };
}

export function demoTasks(): TaskView[] {
  return [
    {
      id: "task-101",
      goal: "Verify SSE event stream replay & cursor resume",
      goalVersion: 2,
      status: "running",
      coordinatorBotId: "bot-juno",
      participantBotIds: ["bot-juno", "bot-moss", "bot-vesper"],
      updatedAt: ago(2),
      sessions: [
        {
          id: "sess-1",
          botId: "bot-juno",
          label: "s-1 · Plan",
          status: "completed",
          brief:
            "Scope SSE Last-Event-ID cursor boundaries and assign implementation & test sessions.",
          tools: ["read_file(apps/api/src/routes.ts)"],
          evidence: "Plan aligned on goalVersion 2",
        },
        {
          id: "sess-2",
          botId: "bot-moss",
          parentSessionId: "sess-1",
          label: "s-2 · Replay patch",
          status: "running",
          brief:
            "Ensure /tasks/:id/stream resumes strictly after sequence cursor without duplicate emissions.",
          tools: ["edit_file(routes.ts)", "run_test(backend.test.ts)"],
          evidence: "Streaming 14 events in order; running edge test...",
        },
        {
          id: "sess-3",
          botId: "bot-vesper",
          parentSessionId: "sess-1",
          label: "s-3 · QA Gate",
          status: "verifying",
          brief:
            "Validate monotonic sequence numbers and zero duplicate events across reconnect.",
          tools: ["verify_stream_cursor(after=4)"],
          evidence: "Checking reconnect from sequence #4 -> #9",
        },
      ],
      checks: [
        {
          id: "chk-1",
          description:
            "Reconnect with Last-Event-ID resumes without gaps or duplicates",
          outcome: "passed",
          evidence:
            "backend.test.ts: events [5, 6, 7] received cleanly after cursor 4",
        },
        {
          id: "chk-2",
          description: "Contract schema remains backward-compatible",
          outcome: "inconclusive",
          evidence: "Awaiting s-2 completion for final snapshot check",
        },
      ],
      messages: [
        {
          id: "tm-1",
          authorId: "user",
          authorKind: "user",
          intent: "discussion",
          text: "Audit the SSE reconnect flow and make sure event replay doesn't drop or duplicate messages.",
          createdAt: ago(9),
        },
        {
          id: "tm-2",
          authorId: "bot-juno",
          authorKind: "bot",
          intent: "assignment",
          text: "@Moss take session s-2 to test cursor boundary conditions. @Vesper prepare reconnect verification.",
          createdAt: ago(8),
        },
        {
          id: "tm-3",
          authorId: "bot-moss",
          authorKind: "bot",
          intent: "discussion",
          text: "Checked routes.ts — Last-Event-ID header falls back to ?after query param. Writing a reconnect test case now.",
          createdAt: ago(6),
        },
        {
          id: "tm-4",
          authorId: "user",
          authorKind: "user",
          intent: "steering",
          text: "Keep the payload schema unchanged while doing that.",
          createdAt: ago(5),
        },
        {
          id: "tm-5",
          authorId: "system",
          authorKind: "system",
          intent: "notification",
          text: "Goal updated to v2 · Active sessions notified",
          createdAt: ago(5),
        },
        {
          id: "tm-6",
          authorId: "bot-vesper",
          authorKind: "bot",
          intent: "result",
          text: "Criterion 1 passed: reconnecting with Last-Event-ID: 4 replayed sequences 5..7 with zero duplicates.",
          createdAt: ago(3),
        },
      ],
    },
    {
      id: "task-102",
      goal: "Consolidate v0.2 contract schemas across packages",
      goalVersion: 1,
      status: "completed",
      coordinatorBotId: "bot-kite",
      participantBotIds: ["bot-kite", "bot-vesper"],
      updatedAt: ago(60),
      sessions: [
        {
          id: "sess-201",
          botId: "bot-kite",
          label: "s-1 · Schema diff",
          status: "completed",
          brief: "Compare packages/contracts exports against API routes.",
          tools: ["read_file(packages/contracts/src/index.ts)"],
          evidence: "All 14 event types and taskViewSchema validated.",
        },
        {
          id: "sess-202",
          botId: "bot-vesper",
          parentSessionId: "sess-201",
          label: "s-2 · Contract tests",
          status: "completed",
          brief: "Run contract unit tests.",
          tools: ["npm test -w @jj/contracts"],
          evidence: "contracts.test.ts passed (8/8)",
        },
      ],
      checks: [
        {
          id: "chk-201",
          description: "All Zod schemas pass strict validation tests",
          outcome: "passed",
          evidence: "packages/contracts/src/contracts.test.ts: 8 passed",
        },
      ],
      messages: [
        {
          id: "tm-201",
          authorId: "bot-kite",
          authorKind: "bot",
          intent: "discussion",
          text: "Audited all exported schemas in @jj/contracts.",
          createdAt: ago(73),
        },
        {
          id: "tm-202",
          authorId: "bot-vesper",
          authorKind: "bot",
          intent: "result",
          text: "All 8 contract invariants verified and passing.",
          createdAt: ago(70),
        },
      ],
    },
    {
      id: "task-103",
      goal: "Benchmark worker queue lease recovery under timeout",
      goalVersion: 1,
      status: "queued",
      coordinatorBotId: "bot-juno",
      participantBotIds: ["bot-juno", "bot-moss"],
      updatedAt: ago(180),
      sessions: [
        {
          id: "sess-301",
          botId: "bot-moss",
          label: "s-1 · Lease test",
          status: "queued",
          brief: "Simulate expired worker lease and verify clean job reclaim.",
          tools: [],
          evidence: "Queued behind active session s-2",
        },
      ],
      checks: [
        {
          id: "chk-301",
          description: "Expired job lease is reclaimed by next worker tick",
          outcome: "inconclusive",
          evidence: "Not run yet",
        },
      ],
      messages: [
        {
          id: "tm-301",
          authorId: "bot-juno",
          authorKind: "bot",
          intent: "assignment",
          text: "Queued session s-1 for Moss once the SSE replay verification wraps up.",
          createdAt: ago(200),
        },
      ],
    },
  ];
}
