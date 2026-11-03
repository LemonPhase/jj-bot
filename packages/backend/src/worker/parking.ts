// Parking: a session with open delegations that keeps checking on the task,
// turn after turn, is waiting in all but name, so the engine ends its run as
// waiting (outcomes.ts) instead of paying for model calls while a worker is
// slow. Results are delivered, never polled for: one still wakes the session
// as usual. Prompting alone does not stop live models from polling (#115).
import type { TurnCall } from "../ports";
import { openChildren } from "../services/sessions";
import { LOOKUP_TOOLS } from "./lookup-tools";
import type { RunContext } from "./run-context";

/**
 * Calls that poll the task: the lookups of its shared record, and
 * `complete_task`, which is refused while a delegation is open. A turn with
 * one of them, and nothing but `WAITING_TOOLS`, counts toward parking.
 */
export const POLLING_TOOLS: ReadonlySet<string> = new Set([
  ...LOOKUP_TOOLS,
  "complete_task",
]);

/**
 * The read-only coding tools. A session may explore the workspace while its
 * delegations run, so a turn of these alone does not count toward parking;
 * it is no work either, so it does not start the count over.
 */
export const WORKSPACE_READS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "find",
  "ls",
]);

/**
 * Calls that move nothing forward while delegations are open. Any other
 * tool, one added later included, is work and starts the count over, so a
 * new tool never parks a session by accident.
 */
export const WAITING_TOOLS: ReadonlySet<string> = new Set([
  ...POLLING_TOOLS,
  ...WORKSPACE_READS,
]);

/**
 * Turns that poll, with no work and no waking input in between, after which
 * a session with open delegations is parked. The last of them runs none of
 * its calls.
 */
export const PARK_AFTER_TURNS = 3;

/** The result of each call of the turn that parks a session. */
export const parkedText = (open: number) =>
  `Not run: the engine ended your turn here to wait for your ${open} open delegation${open === 1 ? "" : "s"}. You checked on the task in ${PARK_AFTER_TURNS} turns without doing other work or receiving a result, and delegations are not polled: each result arrives as a message and starts your next turn.`;

/** Whether `text` is `parkedText`, for some count of open delegations. */
export function isParkedText(text: string): boolean {
  const open =
    /^Not run: the engine ended your turn here to wait for your (\d+) /.exec(
      text,
    );
  return open !== null && text === parkedText(Number(open[1]));
}

/**
 * `RunHooks.reviewTurn`: counts the run's polling turns (work starts the
 * count over here, and `takeInbox` does when it delivers a brief, a result
 * or steering) and parks the session at `PARK_AFTER_TURNS` while it has open
 * delegations.
 */
export async function reviewTurn(
  rc: RunContext,
  calls: readonly TurnCall[],
): Promise<string | undefined> {
  if (
    calls.length === 0 ||
    calls.some((call) => !WAITING_TOOLS.has(call.tool))
  ) {
    rc.lookupTurns = 0;
    return undefined;
  }
  if (!calls.some((call) => POLLING_TOOLS.has(call.tool))) return undefined;
  rc.lookupTurns += 1;
  if (rc.lookupTurns < PARK_AFTER_TURNS) return undefined;
  const open = await openChildren(rc.deps.ctx.db, rc.session);
  return open.length > 0 ? parkedText(open.length) : undefined;
}
