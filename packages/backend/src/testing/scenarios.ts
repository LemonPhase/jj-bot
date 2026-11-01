// Reusable brains and setup for engine tests.
import type { Engine } from "../engine";
import { type Brain, type BrainView, said } from "./fake-executor";
import { uniqueName } from "./harness";

export const uniqueNameFor = uniqueName;

export interface Team {
  names: string[];
  ids: string[];
  byName: Record<string, string>;
}

/** Creates bots with unique names (`base` + suffix). */
export async function createTeam(
  engine: Engine,
  bases: string[],
  extra: { role?: string; instructions?: string } = {},
): Promise<Team> {
  const names: string[] = [];
  const ids: string[] = [];
  for (const base of bases) {
    const name = uniqueName(base);
    const { bot } = await engine.bots.create({
      name,
      role: extra.role ?? `${base} role`,
      instructions: extra.instructions,
    });
    names.push(name);
    ids.push(bot.id);
  }
  return {
    names,
    ids,
    byName: Object.fromEntries(
      names.map((name, index) => [name, ids[index] as string]),
    ),
  };
}

export const lastResult = (view: BrainView) => said.results(view).at(-1);

/** The name of each worker whose result header the coordinator has seen. */
export const reported = (view: BrainView, workers: string[]) =>
  workers.filter(
    (name) =>
      said.heard(view, `Result from ${name} (session`) ||
      said.heard(view, `Failure from ${name} (session`),
  );

/**
 * A coordinator that delegates one brief per worker, waits for every report,
 * then completes with the reports joined.
 */
export function delegatingCoordinator(
  workers: string[],
  brief: (worker: string) => string = (worker) => `Write ${worker}.txt`,
): Brain {
  return (view) => {
    if (said.turns(view) === 0)
      return {
        calls: workers.map((worker) => ({
          name: "delegate",
          args: { bot: worker, brief: brief(worker) },
        })),
      };
    const done = reported(view, workers);
    // Waits silently: text while delegations are open is posted to the task.
    if (done.length < workers.length) return { text: "" };
    if (lastResult(view)?.name === "complete_task") return { text: "Done." };
    return {
      calls: [
        {
          name: "complete_task",
          args: { result: `Consolidated: ${done.join(", ")}` },
        },
      ],
    };
  };
}

/** A worker that writes `<name>.txt` and reports. */
export function writingWorker(name: string): Brain {
  return (view) => {
    if (said.turns(view) === 0)
      return {
        calls: [
          { name: "bash", args: { command: `echo ${name} > ${name}.txt` } },
        ],
      };
    return { text: `${name} wrote ${name}.txt` };
  };
}
