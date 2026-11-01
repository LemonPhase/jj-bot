import { useId } from "react";
import { useApi } from "../../api/ApiContext";
import {
  Icon,
  IconButton,
  ModeBadge,
  SectionLabel,
  Segmented,
  ThemeToggle,
  Tooltip,
  Wordmark,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotList } from "../bots/BotList";
import { TaskList } from "../tasks/TaskList";
import { modeBadgeFor } from "./modeBadge";
import { botHref, type Route, SETTINGS_HREF, type Section } from "./router";
import { useShell } from "./ShellContext";

export interface SidebarProps {
  route: Route;
  /** The list on show: the route's own, or the last one for Settings. */
  section: Section;
  onSwitchSection: (section: Section) => void;
}

/**
 * The sidebar (SPEC §3): brand and New button, the Bots/Tasks switch, the
 * section's list, then the mode badge, Settings and the theme toggle.
 */
export function Sidebar({ route, section, onSwitchSection }: SidebarProps) {
  const api = useApi();
  const { bots, tasks } = useWorkspace();
  const { openNewBot, openNewTask } = useShell();
  const listLabelId = useId();
  const badge = modeBadgeFor(api.badge);

  return (
    <aside className="shell-sidebar" aria-label="Navigation">
      <div className="shell-brand-row">
        <a className="shell-brand" href={botHref(null)}>
          <Wordmark />
        </a>
        {section === "bots" ? (
          <IconButton
            label="New bot"
            tone="ink"
            icon={<Icon name="plus" size={16} />}
            current={route.name === "studio" && route.botId === null}
            onClick={openNewBot}
          />
        ) : (
          <IconButton
            label="New task"
            tone="ink"
            icon={<Icon name="plus" size={16} />}
            onClick={() => openNewTask()}
          />
        )}
      </div>

      {/* On Settings neither item is current, so both lead back to a list. */}
      <Segmented<Section | "settings">
        kind="nav"
        label="Primary"
        value={route.name === "settings" ? "settings" : section}
        onChange={(next) => {
          if (next !== "settings") onSwitchSection(next);
        }}
        options={[
          { value: "bots", label: "Bots", count: bots.length },
          { value: "tasks", label: "Tasks", count: tasks.length },
        ]}
      />

      <div className="shell-list">
        <SectionLabel as="h2" id={listLabelId} className="shell-list__label">
          {section === "bots" ? "Bots" : "Tasks"}
        </SectionLabel>
        {section === "bots" ? (
          <BotList labelledBy={listLabelId} />
        ) : (
          <TaskList labelledBy={listLabelId} />
        )}
      </div>

      <div className="shell-footer">
        <ModeBadge kind={badge.kind} title={badge.title} />
        <div className="shell-footer__actions">
          {/* The label repeats the accessible name, so the tip does not describe. */}
          <Tooltip content="Settings" placement="auto" describe={false}>
            <a
              className="ui-icon-btn"
              href={SETTINGS_HREF}
              aria-label="Settings"
              aria-current={route.name === "settings" ? "page" : undefined}
            >
              <Icon name="settings" size={16} />
            </a>
          </Tooltip>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
