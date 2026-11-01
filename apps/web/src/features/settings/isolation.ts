import type { RuntimeProfile, SandboxDriverInfo } from "@jj/contracts";
import type { StatusTone } from "../../lib/status";

/**
 * How profiles and drivers report isolation and availability. The server
 * computes both; the UI only labels them, and a driver without filesystem
 * isolation is always called "Unisolated".
 */

export const isolationLabel = (isolated: boolean) =>
  isolated ? "Isolated" : "Unisolated";

export interface Availability {
  tone: StatusTone;
  word: string;
}

export function profileAvailability(
  status: RuntimeProfile["status"],
): Availability {
  return status.driverAvailable
    ? { tone: "completed", word: "available" }
    : { tone: "failed", word: "driver unavailable" };
}

export function driverAvailability(
  driver: Pick<SandboxDriverInfo, "available">,
): Availability {
  return driver.available
    ? { tone: "completed", word: "available" }
    : { tone: "failed", word: "unavailable" };
}

/** The one-paragraph difference between the in-tree drivers. */
export const ISOLATION_HELP =
  "Docker runs each task in its own container, so agent-run commands cannot reach the server's files, environment or other workspaces, and network and resource limits are enforced. Local runs commands directly on the server in a task folder: unisolated, with open network and no limits, so use it only for trusted work.";
