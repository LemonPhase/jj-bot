/**
 * The demo's scripted task runs. A script is a list of steps; each step emits
 * contract `TaskEvent`s through its host, which folds them onto the task view
 * with `applyTaskEvent` and streams them to subscribers, exactly as the live
 * stream would. Every text a script writes says it is simulated.
 */
import {
  type Artifact,
  type ExecutionSession,
  isFinishedStatus,
  type Task,
  type TaskEventOf,
  type TaskEventType,
  type TaskMessage,
  type TaskView,
  type Usage,
} from "@jj/contracts";
import { DEMO_MODEL_REF } from "./demoFixtures";

export type Step = () => void;

export interface EventRef {
  botId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  causedBy?: string | null;
}

export type IdKind = "session" | "message" | "run" | "tool" | "artifact";

/** What the demo server provides to a script for one task. */
export interface ScriptHost {
  readonly taskId: string;
  view(): TaskView;
  now(): string;
  nextId(kind: IdKind): string;
  emit<Type extends TaskEventType>(
    type: Type,
    payload: TaskEventOf<Type>["payload"],
    ref?: EventRef,
  ): TaskEventOf<Type>;
  botName(botId: string): string;
  /** The current run of each session. */
  readonly runs: Map<string, string>;
  storeArtifact(artifactId: string, content: string): void;
}

const DEMO_NOTE =
  "This is demo data: nothing was executed and no model was called.";

/** Not a real SHA-256: a stable placeholder digest for demo artifacts. */
function demoDigest(content: string): string {
  let out = "";
  for (let round = 0; round < 8; round += 1) {
    let value = 0x811c9dc5 ^ round;
    for (let index = 0; index < content.length; index += 1) {
      value ^= content.charCodeAt(index);
      value = Math.imul(value, 0x01000193);
    }
    out += (value >>> 0).toString(16).padStart(8, "0");
  }
  return out;
}

/** Event helpers over a host: each call emits the events a real engine would. */
class Ops {
  private modelCalls = 0;
  constructor(private readonly host: ScriptHost) {}

  private session(sessionId: string): ExecutionSession {
    const session = this.host.view().sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error(`Demo script: no session ${sessionId}`);
    return session;
  }

  private ref(sessionId: string): EventRef {
    const session = this.session(sessionId);
    return {
      botId: session.botId,
      sessionId,
      runId: this.host.runs.get(sessionId) ?? null,
    };
  }

  task(): Task {
    return this.host.view().task;
  }

  updateTask(patch: Partial<Task>) {
    const previous = this.task();
    this.host.emit("task.updated", {
      task: { ...previous, ...patch, updatedAt: this.host.now() },
      previousStatus: previous.status,
    });
  }

  finishTask(
    status: "completed" | "failed" | "cancelled",
    result: string | null,
  ) {
    const finishedAt = this.host.now();
    this.updateTask({ status, result, finishedAt });
    this.host.emit("task.finished", { status, result, error: null });
  }

  createSession(input: {
    botId: string;
    parentSessionId: string | null;
    role: ExecutionSession["role"];
    brief: string;
    depth: number;
  }): string {
    const id = this.host.nextId("session");
    const now = this.host.now();
    this.host.emit(
      "session.created",
      {
        session: {
          id,
          taskId: this.host.taskId,
          ...input,
          goalVersion: this.task().goalVersion,
          status: "queued",
          waitingFor: null,
          result: null,
          error: null,
          activity: null,
          runCount: 0,
          createdAt: now,
          updatedAt: now,
          startedAt: null,
          finishedAt: null,
        },
      },
      { botId: input.botId, sessionId: id },
    );
    return id;
  }

  updateSession(sessionId: string, patch: Partial<ExecutionSession>) {
    const previous = this.session(sessionId);
    this.host.emit(
      "session.updated",
      {
        session: { ...previous, ...patch, updatedAt: this.host.now() },
        previousStatus: previous.status,
      },
      this.ref(sessionId),
    );
  }

  startRun(sessionId: string, reason: "start" | "wake" | "recovery") {
    const session = this.session(sessionId);
    this.host.runs.set(sessionId, this.host.nextId("run"));
    this.updateSession(sessionId, {
      status: "running",
      waitingFor: null,
      goalVersion: this.task().goalVersion,
      runCount: session.runCount + 1,
      startedAt: session.startedAt ?? this.host.now(),
      finishedAt: null,
    });
    this.host.emit("run.started", { reason }, this.ref(sessionId));
  }

  finishRun(
    sessionId: string,
    outcome: "completed" | "waiting" | "cancelled",
    patch: Partial<ExecutionSession> = {},
  ) {
    this.host.emit("run.finished", { outcome }, this.ref(sessionId));
    this.updateSession(sessionId, {
      status: outcome,
      waitingFor: null,
      ...patch,
      finishedAt: outcome === "waiting" ? null : this.host.now(),
    });
    this.host.runs.delete(sessionId);
  }

  modelStarted(sessionId: string) {
    this.host.emit("model.started", {}, this.ref(sessionId));
  }

  modelFinished(sessionId: string, text?: string) {
    const call = ++this.modelCalls;
    const usage: Usage = {
      modelCalls: 1,
      inputTokens: 1100 + call * 140,
      outputTokens: 160 + call * 25,
      cacheReadTokens: call > 1 ? 900 : 0,
      cacheWriteTokens: call === 1 ? 900 : 0,
      costUsd: 0,
    };
    this.host.emit(
      "model.finished",
      {
        model: DEMO_MODEL_REF,
        stopReason: "end_turn",
        usage,
        ...(text ? { text } : {}),
      },
      this.ref(sessionId),
    );
  }

  toolStarted(sessionId: string, tool: string, summary: string): ToolCall {
    const toolCallId = this.host.nextId("tool");
    this.host.emit(
      "tool.started",
      { toolCallId, tool, summary },
      this.ref(sessionId),
    );
    return { toolCallId, tool, summary };
  }

  toolFinished(
    sessionId: string,
    call: ToolCall,
    result: { ok: boolean; output?: string; exitCode?: number | null },
  ) {
    this.host.emit(
      "tool.finished",
      {
        ...call,
        ok: result.ok,
        ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        interrupted: "no",
        ...(result.output === undefined ? {} : { output: result.output }),
        truncated: false,
      },
      this.ref(sessionId),
    );
  }

  artifact(sessionId: string, path: string, content: string): Artifact {
    const id = this.host.nextId("artifact");
    this.host.storeArtifact(id, content);
    const artifact: Artifact = {
      id,
      taskId: this.host.taskId,
      sessionId,
      runId: this.host.runs.get(sessionId) ?? null,
      kind: "file",
      path,
      name: path.split("/").at(-1) ?? path,
      contentType: "text/markdown",
      sizeBytes: new TextEncoder().encode(content).length,
      sha256: demoDigest(content),
      createdAt: this.host.now(),
    };
    this.host.emit("artifact.created", { artifact }, this.ref(sessionId));
    return artifact;
  }

  post(
    message: Pick<
      TaskMessage,
      | "authorKind"
      | "authorBotId"
      | "sessionId"
      | "intent"
      | "text"
      | "recipientBotIds"
    >,
  ): TaskMessage {
    const posted: TaskMessage = {
      ...message,
      id: this.host.nextId("message"),
      taskId: this.host.taskId,
      sequence: this.host.view().messages.length + 1,
      createdAt: this.host.now(),
    };
    this.host.emit(
      "message.posted",
      { message: posted },
      message.sessionId
        ? this.ref(message.sessionId)
        : { botId: message.authorBotId },
    );
    return posted;
  }
}

interface ToolCall {
  toolCallId: string;
  tool: string;
  summary: string;
}

interface Worker {
  botId: string;
  sessionId: string;
  call: ToolCall | null;
}

/** What each delegated worker does, in three phases between "started" and "reported". */
interface WorkPlan {
  brief: string;
  phases: ((ops: Ops, worker: Worker) => void)[];
  result: string;
}

const findings = (title: string) =>
  `# Findings: ${title}\n\n- Ran the checks for this goal (simulated).\n- Nothing failed in the demo run.\n\n${DEMO_NOTE}\n`;

const workPlans = (title: string): WorkPlan[] => [
  {
    brief:
      "Run the relevant checks and write up what you find in notes/findings.md.",
    phases: [
      (ops, w) => {
        ops.modelFinished(w.sessionId);
        w.call = ops.toolStarted(w.sessionId, "bash", "npm test");
      },
      (ops, w) => {
        if (w.call)
          ops.toolFinished(w.sessionId, w.call, {
            ok: true,
            exitCode: 0,
            output: "Demo output: 12 tests passed (simulated, nothing ran).",
          });
        w.call = ops.toolStarted(w.sessionId, "write", "notes/findings.md");
      },
      (ops, w) => {
        if (w.call)
          ops.toolFinished(w.sessionId, w.call, {
            ok: true,
            output: "Wrote notes/findings.md",
          });
        ops.artifact(w.sessionId, "notes/findings.md", findings(title));
        ops.modelStarted(w.sessionId);
      },
    ],
    result: "Ran the checks and wrote notes/findings.md (simulated).",
  },
  {
    brief:
      "Review the relevant docs and code and list anything that looks risky.",
    phases: [
      (ops, w) => {
        ops.modelFinished(w.sessionId);
        w.call = ops.toolStarted(w.sessionId, "read", "docs/architecture.md");
      },
      (ops, w) => {
        if (w.call)
          ops.toolFinished(w.sessionId, w.call, {
            ok: true,
            output: "Demo output: file contents are not shown in demo mode.",
          });
        w.call = ops.toolStarted(w.sessionId, "grep", "TODO");
      },
      (ops, w) => {
        if (w.call)
          ops.toolFinished(w.sessionId, w.call, {
            ok: true,
            exitCode: 0,
            output: "Demo output: 2 matches (simulated).",
          });
        ops.modelStarted(w.sessionId);
      },
    ],
    result:
      "Reviewed the docs and code; two TODOs are worth a look (simulated).",
  },
];

/** The coordinator delegates to up to two workers, waits for their results, then completes the task. */
export function teamScript(host: ScriptHost): Step[] {
  const ops = new Ops(host);
  const { task } = host.view();
  const coordinatorId = task.coordinatorBotId;
  const plans = workPlans(task.title);
  const workers: Worker[] = task.participantBotIds
    .filter((botId) => botId !== coordinatorId)
    .slice(0, 2)
    .map((botId) => ({ botId, sessionId: "", call: null }));
  let coordinator = "";
  let call: ToolCall | null = null;
  const steps: Step[] = [];

  steps.push(() => {
    coordinator = ops.createSession({
      botId: coordinatorId,
      parentSessionId: null,
      role: "coordinator",
      brief: ops.task().goal,
      depth: 0,
    });
    ops.updateTask({ status: "running" });
    ops.startRun(coordinator, "start");
    ops.modelStarted(coordinator);
  });

  if (workers.length === 0) {
    // Nobody to delegate to: the coordinator does the work itself.
    const solo: Worker = { botId: coordinatorId, sessionId: "", call: null };
    for (const phase of plans[0]?.phases ?? [])
      steps.push(() => {
        solo.sessionId = coordinator;
        phase(ops, solo);
      });
  } else {
    steps.push(() => {
      ops.modelFinished(coordinator, "Splitting the goal between the team.");
      call = ops.toolStarted(
        coordinator,
        "delegate",
        host.botName(workers[0]?.botId ?? ""),
      );
    });
    workers.forEach((worker, index) => {
      const plan = plans[index];
      steps.push(() => {
        worker.sessionId = ops.createSession({
          botId: worker.botId,
          parentSessionId: coordinator,
          role: "worker",
          brief: plan?.brief ?? "",
          depth: 1,
        });
        ops.post({
          authorKind: "bot",
          authorBotId: coordinatorId,
          sessionId: coordinator,
          intent: "assignment",
          text: `@${host.botName(worker.botId)} ${plan?.brief ?? ""}`,
          recipientBotIds: [worker.botId],
        });
        if (call)
          ops.toolFinished(coordinator, call, {
            ok: true,
            output: `Delegated to ${host.botName(worker.botId)}`,
          });
        const next = workers[index + 1];
        if (next)
          call = ops.toolStarted(
            coordinator,
            "delegate",
            host.botName(next.botId),
          );
        else
          ops.finishRun(coordinator, "waiting", { waitingFor: "delegations" });
      });
    });
    steps.push(() => {
      for (const worker of workers) {
        ops.startRun(worker.sessionId, "start");
        ops.modelStarted(worker.sessionId);
      }
    });
    for (let phase = 0; phase < 3; phase += 1)
      steps.push(() => {
        workers.forEach((worker, index) => {
          plans[index]?.phases[phase]?.(ops, worker);
        });
      });
    workers.forEach((worker, index) => {
      steps.push(() => {
        const result = plans[index]?.result ?? "Done (simulated).";
        ops.modelFinished(worker.sessionId);
        ops.post({
          authorKind: "bot",
          authorBotId: worker.botId,
          sessionId: worker.sessionId,
          intent: "result",
          text: result,
          recipientBotIds: [coordinatorId],
        });
        ops.finishRun(worker.sessionId, "completed", { result });
      });
    });
    steps.push(() => {
      ops.startRun(coordinator, "wake");
      ops.modelStarted(coordinator);
    });
  }

  steps.push(() => {
    ops.modelFinished(coordinator);
    call = ops.toolStarted(coordinator, "complete_task", "");
  });
  steps.push(() => {
    const names = workers.map((w) => host.botName(w.botId));
    const result = `Demo result for “${ops.task().title}”: ${
      names.length
        ? `${names.join(" and ")} finished their parts`
        : "the work is finished"
    }. ${DEMO_NOTE}`;
    if (call) ops.toolFinished(coordinator, call, { ok: true });
    ops.post({
      authorKind: "bot",
      authorBotId: coordinatorId,
      sessionId: coordinator,
      intent: "result",
      text: result,
      recipientBotIds: [],
    });
    ops.finishRun(coordinator, "completed", { result });
    ops.finishTask("completed", result);
  });
  return steps;
}

/** The coordinator asks the user a question and waits for the answer. */
export function askScript(host: ScriptHost): Step[] {
  const ops = new Ops(host);
  const { task } = host.view();
  let coordinator = "";
  return [
    () => {
      coordinator = ops.createSession({
        botId: task.coordinatorBotId,
        parentSessionId: null,
        role: "coordinator",
        brief: task.goal,
        depth: 0,
      });
      ops.updateTask({ status: "running" });
      ops.startRun(coordinator, "start");
      ops.modelStarted(coordinator);
    },
    () => {
      ops.modelFinished(coordinator);
      ops.post({
        authorKind: "bot",
        authorBotId: task.coordinatorBotId,
        sessionId: coordinator,
        intent: "discussion",
        text: "Before I plan this: should we keep a fallback while it rolls out, or switch over in one go? (Demo question: reply to continue the scripted run.)",
        recipientBotIds: [],
      });
      ops.finishRun(coordinator, "waiting", { waitingFor: "user" });
      ops.updateTask({ status: "waiting" });
    },
  ];
}

/** After a user message reopens a task: the coordinator wakes up and completes it. */
export function continueScript(host: ScriptHost): Step[] {
  const ops = new Ops(host);
  const coordinatorOf = () =>
    host.view().sessions.find((s) => s.parentSessionId === null);
  let call: ToolCall | null = null;
  return [
    () => {
      const coordinator = coordinatorOf();
      if (coordinator) {
        ops.startRun(coordinator.id, "wake");
        ops.modelStarted(coordinator.id);
      }
    },
    () => {
      const coordinator = coordinatorOf();
      if (!coordinator) return;
      ops.modelFinished(coordinator.id);
      call = ops.toolStarted(coordinator.id, "complete_task", "");
    },
    () => {
      const coordinator = coordinatorOf();
      const result = `Demo result: noted your reply and wrapped up “${ops.task().title}”. ${DEMO_NOTE}`;
      if (coordinator) {
        if (call) ops.toolFinished(coordinator.id, call, { ok: true });
        ops.post({
          authorKind: "bot",
          authorBotId: coordinator.botId,
          sessionId: coordinator.id,
          intent: "result",
          text: result,
          recipientBotIds: [],
        });
        ops.finishRun(coordinator.id, "completed", { result });
      }
      ops.finishTask("completed", result);
    },
  ];
}

/** Records a stop request; the returned step completes the cancellation. */
export function requestCancel(host: ScriptHost, reason: string | null): Step {
  const ops = new Ops(host);
  ops.updateTask({ cancelRequestedAt: host.now(), cancelReason: reason });
  host.emit("cancellation.requested", { reason });
  return () => {
    const stopped: { sessionId: string; botId: string; interrupted: "no" }[] =
      [];
    const neverStarted: string[] = [];
    for (const session of host.view().sessions) {
      if (isFinishedStatus(session.status)) continue;
      if (session.status === "queued") {
        neverStarted.push(session.id);
        ops.updateSession(session.id, {
          status: "cancelled",
          waitingFor: null,
          finishedAt: host.now(),
        });
      } else if (session.status === "running") {
        stopped.push({
          sessionId: session.id,
          botId: session.botId,
          interrupted: "no",
        });
        ops.finishRun(session.id, "cancelled");
      } else {
        ops.updateSession(session.id, {
          status: "cancelled",
          waitingFor: null,
          finishedAt: host.now(),
        });
      }
    }
    host.emit("cancellation.completed", { stopped, neverStarted });
    ops.finishTask("cancelled", null);
  };
}

/** A user message: steering for the coordinator, and a reopen when the task had stopped working. */
export function userMessage(
  host: ScriptHost,
  input: { text: string; goal?: string },
): { message: TaskMessage; reopened: boolean } {
  const ops = new Ops(host);
  const task = ops.task();
  const message = ops.post({
    authorKind: "user",
    authorBotId: null,
    sessionId: null,
    intent: "steering",
    text: input.text,
    recipientBotIds: [task.coordinatorBotId],
  });
  if (input.goal !== undefined) {
    const goalVersion = task.goalVersion + 1;
    host.emit("task.goal_changed", { goal: input.goal, goalVersion });
    ops.updateTask({ goal: input.goal, goalVersion });
  }
  const previous = task.status;
  const reopened =
    previous === "waiting" || previous === "completed" || previous === "failed";
  if (reopened) {
    host.emit("task.reopened", { previous });
    ops.updateTask({ status: "running", finishedAt: null });
  }
  const coordinator = host
    .view()
    .sessions.find((s) => s.parentSessionId === null);
  host.emit(
    "steering.received",
    {
      messageId: message.id,
      goalVersion: ops.task().goalVersion,
      delivered: coordinator?.status === "running" ? "injected" : "queued",
    },
    coordinator
      ? {
          botId: coordinator.botId,
          sessionId: coordinator.id,
          runId: host.runs.get(coordinator.id) ?? null,
        }
      : {},
  );
  return { message, reopened };
}
