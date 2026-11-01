/**
 * Memoised task-view derivations, recomputed only when their inputs change
 * (a task event replaces the view, but most leave sessions or events alone).
 */
import type { TaskView } from "@jj/contracts";
import { useMemo, useRef } from "react";
import {
  ordinalsOf,
  type SessionTools,
  sessionTree,
  toolCallsBySession,
} from "./taskModel";

/** The session tree, rebuilt only when the sessions change. */
export const useSessionTree = (view: TaskView) =>
  useMemo(() => sessionTree(view), [view.sessions]);

/** "s-2" for each session id. */
export const useOrdinals = (view: TaskView) =>
  useMemo(() => ordinalsOf(view), [view.sessions]);

const NO_TOOLS: SessionTools = { calls: [], partial: false };
const NO_TOOLS_LOADED: SessionTools = { calls: [], partial: true };

/**
 * Each session's tool calls. Entries that did not change keep their identity
 * across events, so memoised rows given them skip re-rendering.
 */
export function useSessionTools(
  view: TaskView,
): (sessionId: string) => SessionTools {
  const previous = useRef<ReadonlyMap<string, SessionTools>>(new Map());
  return useMemo(() => {
    const map = toolCallsBySession(view, previous.current);
    previous.current = map;
    return (sessionId: string) =>
      map.get(sessionId) ??
      (view.hasEarlier ? { ...NO_TOOLS, partial: true } : NO_TOOLS);
  }, [view.events, view.hasEarlier]);
}
