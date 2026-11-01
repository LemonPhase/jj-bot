/**
 * Demo tasks with large execution graphs, for tests and visual checks only
 * (never the default demo seed). Pass them to `createDemoApi({ tasks })`.
 */
import type { DemoTaskSeed } from "../api/demoFixtures";
import { Ops, type ScriptHost, type Step } from "../api/demoScript";

const WORKERS = ["bot-kite", "bot-moss", "bot-vesper"] as const;
const worker = (index: number) => WORKERS[index % WORKERS.length] as string;

const rootId = (host: ScriptHost) => {
  const root = host.view().sessions.find((s) => s.parentSessionId === null);
  if (!root) throw new Error("Graph fixture: the task has no root session.");
  return root.id;
};

const WIDE_BRIEFS = [
  "Implement the CLI in wordfreq.js only.",
  "Write the tests in wordfreq.test.js only.",
  "Write README.md only: usage, interface and examples.",
  "Add package.json with an npm test script.",
  "Write sample.txt, a fixture for the tests.",
  "Review wordfreq.js for edge cases and report them.",
  "Check the CLI against the README examples.",
];

/**
 * Seven delegations from the coordinator at once, one of them with a helper
 * of its own: the shape of the acceptance run whose graph clipped the root.
 */
function wideScript(host: ScriptHost): Step[] {
  const ops = new Ops(host);
  return [
    () => {
      const root = rootId(host);
      ops.startRun(root, "start");
      const children = WIDE_BRIEFS.map((brief, index) => {
        const id = ops.createSession({
          botId: worker(index),
          parentSessionId: root,
          role: "worker",
          brief,
          depth: 1,
        });
        ops.startRun(id, "start");
        return id;
      });
      const helper = ops.createSession({
        botId: "bot-juno",
        parentSessionId: children[1] as string,
        role: "worker",
        brief: "Check the tokenizer handles Unicode words.",
        depth: 2,
      });
      ops.startRun(helper, "start");
      for (const index of [0, 2, 3])
        ops.finishRun(children[index] as string, "completed", {
          result: "Done (fixture: nothing ran).",
        });
      ops.finishRun(children[1] as string, "waiting", {
        waitingFor: "delegations",
      });
      ops.finishRun(root, "waiting", { waitingFor: "delegations" });
    },
  ];
}

/** Each level delegates two pieces, one of which delegates again, six levels down. */
function deepScript(host: ScriptHost): Step[] {
  const ops = new Ops(host);
  return [
    () => {
      let parent = rootId(host);
      ops.startRun(parent, "start");
      for (let depth = 1; depth <= 6; depth += 1) {
        const leaf = ops.createSession({
          botId: worker(depth + 1),
          parentSessionId: parent,
          role: "worker",
          brief: `Check level ${depth} on its own.`,
          depth,
        });
        ops.startRun(leaf, "start");
        ops.finishRun(leaf, "completed", {
          result: "Done (fixture: nothing ran).",
        });
        const next = ops.createSession({
          botId: worker(depth),
          parentSessionId: parent,
          role: "worker",
          brief: `Split level ${depth} and delegate the rest.`,
          depth,
        });
        ops.startRun(next, "start");
        parent = next;
      }
    },
  ];
}

const TEAM = ["bot-juno", ...WORKERS];

export const WIDE_GRAPH_TASK: DemoTaskSeed = {
  id: "task-graph-wide",
  goal: "Fixture: a coordinator with seven delegations",
  coordinatorBotId: "bot-juno",
  participantBotIds: TEAM,
  startedMinutesAgo: 12,
  playedSteps: "all",
  script: wideScript,
  autoplay: false,
};

export const DEEP_GRAPH_TASK: DemoTaskSeed = {
  id: "task-graph-deep",
  goal: "Fixture: delegations six levels deep",
  coordinatorBotId: "bot-juno",
  participantBotIds: TEAM,
  startedMinutesAgo: 8,
  playedSteps: "all",
  script: deepScript,
  autoplay: false,
};

export const GRAPH_FIXTURE_TASKS = [WIDE_GRAPH_TASK, DEEP_GRAPH_TASK];
