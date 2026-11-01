import { createContext, useContext } from "react";

/** Shell-level actions any screen can trigger. Provided by `AppShell`. */
export interface ShellActions {
  /** Starts the new-bot flow (today a dialog; Bot Studio can take over at `#/studio`). */
  openNewBot: () => void;
  /** Opens the new-task dialog with these bots preselected (the first coordinates). */
  openNewTask: (botIds?: string[]) => void;
}

export const ShellContext = createContext<ShellActions | null>(null);

export function useShell(): ShellActions {
  const value = useContext(ShellContext);
  if (!value) throw new Error("useShell must be used inside <AppShell>");
  return value;
}
