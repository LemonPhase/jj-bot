import { createContext, useContext } from "react";

/** Shell-level actions any screen can trigger. Provided by `AppShell`. */
export interface ShellActions {
  /** Opens Bot Studio on a new bot (`#/studio/new`). */
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
