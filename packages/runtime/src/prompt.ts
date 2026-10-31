/**
 * Prompt sections with a fixed, readable format. The engine builds system
 * prompts with these helpers so every model, the scripted test model included,
 * reads rosters and active tasks the same way.
 */

export interface RosterEntry {
  name: string;
  /** The bot's role in the task, for example "coordinator" or "researcher". */
  role: string;
  /** Marks the bot the prompt is written for. */
  self?: boolean;
}

export interface ActiveTaskEntry {
  id: string;
  title: string;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * ```
 * <roster>
 * - Ada (coordinator) [you]
 * - Bob (researcher)
 * </roster>
 * ```
 */
export function formatRoster(entries: readonly RosterEntry[]): string {
  const lines = entries.map(
    (entry) =>
      `- ${oneLine(entry.name)} (${oneLine(entry.role)})${entry.self ? " [you]" : ""}`,
  );
  return ["<roster>", ...lines, "</roster>"].join("\n");
}

export function parseRoster(prompt: string): RosterEntry[] {
  const block = /<roster>\n([\s\S]*?)\n?<\/roster>/.exec(prompt)?.[1] ?? "";
  const entries: RosterEntry[] = [];
  for (const line of block.split("\n")) {
    const match = /^- (.+) \(([^()]*)\)( \[you\])?$/.exec(line.trim());
    if (!match?.[1]) continue;
    entries.push({
      name: match[1],
      role: match[2] ?? "",
      ...(match[3] ? { self: true } : {}),
    });
  }
  return entries;
}

/**
 * ```
 * <active_tasks>
 * - task_123: Build the landing page
 * </active_tasks>
 * ```
 */
export function formatActiveTasks(tasks: readonly ActiveTaskEntry[]): string {
  const lines = tasks.map((task) => `- ${task.id}: ${oneLine(task.title)}`);
  return ["<active_tasks>", ...lines, "</active_tasks>"].join("\n");
}

export function parseActiveTasks(prompt: string): ActiveTaskEntry[] {
  const block =
    /<active_tasks>\n([\s\S]*?)\n?<\/active_tasks>/.exec(prompt)?.[1] ?? "";
  const tasks: ActiveTaskEntry[] = [];
  for (const line of block.split("\n")) {
    const match = /^- ([^:\s]+): (.*)$/.exec(line.trim());
    if (match?.[1]) tasks.push({ id: match[1], title: match[2] ?? "" });
  }
  return tasks;
}
