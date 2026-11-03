import { createContext, useContext } from "react";

/**
 * A task template dialog: a new template (from scratch, or from the open
 * task `fromTaskId` as it is now), editing one, starting a task from one, or
 * confirming its deletion.
 */
export type TemplateDialogRequest =
  | { kind: "new"; fromTaskId?: string }
  | { kind: "edit"; templateId: string }
  | { kind: "start"; templateId: string }
  | { kind: "delete"; templateId: string };

/**
 * A schedule dialog: a new schedule (of the template `templateId`, when
 * given), editing one, or confirming its deletion.
 */
export type ScheduleDialogRequest =
  | { kind: "new"; templateId?: string }
  | { kind: "edit"; scheduleId: string }
  | { kind: "delete"; scheduleId: string };

/** Shell-level actions any screen can trigger. Provided by `AppShell`. */
export interface ShellActions {
  /** Opens Bot Studio on a new bot (`#/studio/new`). */
  openNewBot: () => void;
  /** Opens the new-task dialog with these bots preselected (the first coordinates). */
  openNewTask: (botIds?: string[]) => void;
  /** Opens a task template dialog. */
  openTemplateDialog: (request: TemplateDialogRequest) => void;
  /** Opens a schedule dialog. */
  openScheduleDialog: (request: ScheduleDialogRequest) => void;
}

export const ShellContext = createContext<ShellActions | null>(null);

export function useShell(): ShellActions {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside <AppShell>");
  return value;
}
