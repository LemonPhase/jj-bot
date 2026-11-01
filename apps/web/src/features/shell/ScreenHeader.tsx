import type { ReactNode } from "react";
import { Icon } from "../../components/ui";

export interface ScreenHeaderProps {
  /** Left side: sprite, the screen's <h1>, a status tag. */
  lead: ReactNode;
  /** Right side: pills and icon buttons. */
  actions?: ReactNode;
}

/** The main column header (SPEC §2): space-between, wraps, padding 14px 24px. */
export function ScreenHeader({ lead, actions }: ScreenHeaderProps) {
  return (
    <header className="screen-header">
      <div className="screen-header__lead">{lead}</div>
      {actions && <div className="screen-header__actions">{actions}</div>}
    </header>
  );
}

/** "← Bots": the mono back link Studio's header starts with. */
export function BackLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a className="screen-back" href={href}>
      <Icon name="arrow-left" size={13} />
      {children}
    </a>
  );
}
