// Parking: a session with open delegations that only looks things up, turn
// after turn, is waiting in all but name, so the engine ends its run as
// waiting (outcomes.ts) instead of paying for model calls while a worker is
// slow. Results are delivered, never polled for: one still wakes the session
// as usual. Prompting alone does not stop live models from polling (#115).
import type { TurnCall } from "../ports";
import { openChildren } from "../services/sessions";
import { LOOKUP_TOOLS } from "./lookup-tools";
import type { RunContext } from "./run-context";

/**
 * Calls that move nothing forward while delegations are open: the lookup
 * tools, the read-only coding tools, and `complete_task`, which is refused
 * while a delegation is open. Any other tool, one added later included,
 * counts as work, so a new tool never parks a session by accident.
 */
export const WAITING_TOOLS: ReadonlySet<string> = new Set([
  ...LOOKUP_TOOLS,
  "read",
  "grep",
  "find",
  "ls",
  "complete_task",
]);

/**
 * Consecutive turns that call only `WAITING_TOOLS`, with no inbox input in
 * between, after which a session with open delegations is parked. The last
 * of them runs none of its calls.
 */
export const PARK_AFTER_TURNS = 3;

/** The result of each call of the turn that parks a session. */
export const parkedText = (open: number) =>
  `Not run: the engine ended your turn here to wait for your ${open} open delegation${open === 1 ? "" : "s"}. Your last ${PARK_AFTER_TURNS} turns only looked things up, and delegations are not polled: each result arrives as a message and starts your next turn.`;

/**
 * `RunHooks.reviewTurn`: counts the run's consecutive lookup-only turns
 * (`takeInbox` resets the count when it delivers input) and parks the
 * session at `PARK_AFTER_TURNS` while it has open delegations.
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
  rc.lookupTurns += 1;
  if (rc.lookupTurns < PARK_AFTER_TURNS) return undefined;
  const open = await openChildren(rc.deps.ctx.db, rc.session);
  return open.length > 0 ? parkedText(open.length) : undefined;
}
