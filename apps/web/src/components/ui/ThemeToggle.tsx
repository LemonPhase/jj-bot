import { useTheme } from "../../lib/theme";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";

/**
 * The sidebar-footer theme toggle (SPEC §3): the sun while dark ("Switch to
 * light theme"), the moon while light. It switches to an explicit choice; offer
 * "system" elsewhere with `useTheme().setPreference("system")`.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, toggle } = useTheme();
  const next = resolved === "dark" ? "light" : "dark";
  return (
    <IconButton
      label={`Switch to ${next} theme`}
      icon={<Icon name={resolved === "dark" ? "sun" : "moon"} size={16} />}
      onClick={toggle}
      className={className}
    />
  );
}
