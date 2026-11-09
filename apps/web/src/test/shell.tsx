import type { ReactNode } from "react";
import { vi } from "vitest";
import {
  type ShellActions,
  ShellContext,
} from "../features/shell/ShellContext";

/** Shell actions that record their calls, for components rendered outside `AppShell`. */
export function stubShell(): ShellActions {
  return {
    openNewBot: vi.fn(),
    openNewTask: vi.fn(),
    openTemplateDialog: vi.fn(),
    openScheduleDialog: vi.fn(),
  };
}

/** Provides `actions` (default: stubs) where a test renders a screen part on its own. */
export function TestShell({
  actions = stubShell(),
  children,
}: {
  actions?: ShellActions;
  children: ReactNode;
}) {
  return (
    <ShellContext.Provider value={actions}>{children}</ShellContext.Provider>
  );
}
