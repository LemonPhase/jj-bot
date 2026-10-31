import type { TaskView } from "@jj/contracts";

// DEVELOPMENT FIXTURES ONLY.
//
// `GET /api/bootstrap` returns empty bot/task collections in scaffold mode, so the chat and
// task views are built against these hand-written examples of the agreed contract shapes.
// Nothing here was produced by a model or a running session. The UI must label any screen
// fed by this data, and must never present it as persisted or executed work.
// Replace with real reads once tasks 02 and 04 land the endpoints.

export const FIXTURE_NOTICE =
  "Development fixture · no agent has run and nothing is persisted";

// Non-empty by construction, so the UI always has a task to select.
export const fixtureTaskViews: [TaskView, ...TaskView[]] = [
  {
    task: {
      id: "task-draft-brief",
      goal: "Draft a one-page brief comparing the three reference agent systems, with a cited claim per system.",
      goalVersion: 2,
      coordinatorBotId: "bot-atlas",
      participantBotIds: ["bot-atlas", "bot-beacon", "bot-cinder"],
      verificationPlan: [
        {
          id: "check-citations",
          description:
            "Every claim about a system cites a specific file or doc page.",
          method: "Compare each claim against the linked source.",
          expectedEvidence: "Source URL plus the passage it rests on.",
        },
        {
          id: "check-length",
          description: "The brief fits one page.",
          method: "Count rendered words; budget is 500.",
          expectedEvidence: "Observed word count.",
        },
      ],
      status: "running",
    },
    participants: [
      {
        id: "bot-atlas",
        name: "Atlas",
        instructions:
          "Coordinate tasks, reconcile contributions, verify the integrated result.",
      },
      {
        id: "bot-beacon",
        name: "Beacon",
        instructions: "Research primary sources and quote them precisely.",
      },
      {
        id: "bot-cinder",
        name: "Cinder",
        instructions:
          "Check claims against their cited sources and report failures plainly.",
      },
    ],
    messages: [
      {
        id: "msg-1",
        taskId: "task-draft-brief",
        authorId: "user",
        authorKind: "user",
        text: "Compare the three reference agent systems for me, one page, and cite everything.",
        intent: "discussion",
        activateBotIds: ["bot-atlas"],
      },
      {
        id: "msg-2",
        taskId: "task-draft-brief",
        authorId: "bot-atlas",
        authorKind: "bot",
        text: "Created the task with two checks: a citation per claim, and a 500-word budget. Delegating research to Beacon and checking to Cinder.",
        intent: "assignment",
        activateBotIds: ["bot-beacon", "bot-cinder"],
      },
      {
        id: "msg-3",
        taskId: "task-draft-brief",
        authorId: "bot-beacon",
        authorKind: "bot",
        text: "Pinned the handoff tool and delivery path for the third system. Dropping the links here for whoever needs them later.",
        intent: "notification",
        // Shared with every participant, but deliberately wakes nobody.
        activateBotIds: [],
      },
      {
        id: "msg-4",
        taskId: "task-draft-brief",
        authorId: "bot-cinder",
        authorKind: "bot",
        text: "One claim about the second system had no citation behind it. Sent it back to Beacon rather than passing the check.",
        intent: "result",
        activateBotIds: ["bot-beacon"],
      },
      {
        id: "msg-5",
        taskId: "task-draft-brief",
        authorId: "user",
        authorKind: "user",
        text: "Lead with the architectural difference, not the feature list.",
        intent: "steering",
        activateBotIds: ["bot-atlas"],
      },
      {
        id: "msg-6",
        taskId: "task-draft-brief",
        authorId: "bot-atlas",
        authorKind: "bot",
        text: "Goal updated to version 2. Beacon is reworking the opening; Cinder's earlier pass no longer covers it.",
        intent: "assignment",
        activateBotIds: ["bot-beacon"],
      },
    ],
    sessions: [
      {
        id: "session-beacon-1",
        taskId: "task-draft-brief",
        botId: "bot-beacon",
        goalVersion: 1,
        brief: "Collect one citable claim per reference system.",
        verificationPlan: [
          {
            id: "check-citations",
            description: "Every claim cites a specific file or doc page.",
            method: "Open each link and locate the passage.",
            expectedEvidence: "Source URL plus passage.",
          },
        ],
        status: "completed",
      },
      {
        id: "session-cinder-1",
        taskId: "task-draft-brief",
        botId: "bot-cinder",
        goalVersion: 1,
        brief: "Check Beacon's claims against their cited sources.",
        verificationPlan: [
          {
            id: "check-citations",
            description: "Each claim is supported by its citation.",
            method: "Compare claim to passage.",
            expectedEvidence: "Pass or fail per claim, with the passage.",
          },
        ],
        status: "completed",
      },
      {
        id: "session-beacon-2",
        taskId: "task-draft-brief",
        botId: "bot-beacon",
        parentSessionId: "session-beacon-1",
        goalVersion: 2,
        brief:
          "Rework the opening around the architectural difference and re-cite it.",
        verificationPlan: [
          {
            id: "check-citations",
            description: "The new opening cites its sources.",
            method: "Compare each claim against the linked source.",
            expectedEvidence: "Source URL plus passage.",
          },
        ],
        status: "running",
      },
    ],
    verificationResults: [
      {
        criterionId: "check-citations",
        taskId: "task-draft-brief",
        sessionId: "session-cinder-1",
        goalVersion: 1,
        outcome: "failed",
        evidence: ["https://example.org/reference-two#delivery"],
      },
      {
        criterionId: "check-length",
        taskId: "task-draft-brief",
        sessionId: "session-beacon-1",
        goalVersion: 1,
        outcome: "passed",
        evidence: ["Observed 431 words"],
      },
      {
        criterionId: "check-citations",
        taskId: "task-draft-brief",
        sessionId: "session-beacon-2",
        goalVersion: 2,
        // The reworked opening has not been rechecked yet; this is not a pass.
        outcome: "inconclusive",
        evidence: [],
      },
    ],
    events: [],
    replayCursor: 0,
  },
  {
    task: {
      id: "task-triage-audit",
      goal: "Triage the 34 dependency advisories and say which are actually reachable from our code.",
      goalVersion: 1,
      coordinatorBotId: "bot-atlas",
      participantBotIds: ["bot-atlas", "bot-cinder"],
      verificationPlan: [
        {
          id: "check-reachability",
          description:
            "Each advisory is marked reachable or not, with the import path that decides it.",
          method: "Trace the dependency path from our own source.",
          expectedEvidence: "The import chain, or a note that none exists.",
        },
      ],
      status: "queued",
    },
    participants: [
      {
        id: "bot-atlas",
        name: "Atlas",
        instructions:
          "Coordinate tasks, reconcile contributions, verify the integrated result.",
      },
      {
        id: "bot-cinder",
        name: "Cinder",
        instructions:
          "Check claims against their cited sources and report failures plainly.",
      },
    ],
    messages: [
      {
        id: "msg-audit-1",
        taskId: "task-triage-audit",
        authorId: "user",
        authorKind: "user",
        text: "Work out which of the audit findings actually matter before we deploy anything.",
        intent: "discussion",
        activateBotIds: ["bot-atlas"],
      },
    ],
    sessions: [],
    verificationResults: [],
    events: [],
    replayCursor: 0,
  },
];
