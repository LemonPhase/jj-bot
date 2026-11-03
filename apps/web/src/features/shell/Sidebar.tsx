import { useId } from "react";
import { useApi } from "../../api/ApiContext";
import { liveBadge } from "../../api/liveApi";
import {
  Icon,
  IconButton,
  ModeBadge,
  type ModeBadgeKind,
  SectionLabel,
  Segmented,
  ThemeToggle,
  Tooltip,
  Wordmark,
} from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotList } from "../bots/BotList";
import { useModels } from "../bots/useModels";
import { TaskList } from "../tasks/TaskList";
import { TemplateList } from "../templates/TemplateList";
import { modeBadgeFor } from "./modeBadge";
import { botHref, type Route, SETTINGS_HREF, type Section } from "./router";
import { useShell } from "./ShellContext";

/** What the mode badge says: the API in use and whether a model can run. */
export type ShellBadge = { kind: ModeBadgeKind; title: string };

/**
 * The mode badge for the API in use. Live, it follows the models view, so a
 * key stored in settings shows at once.
 */
export function useModeBadge(): ShellBadge {
  const api = useApi();
  const { models } = useModels();
  return modeBadgeFor(
    api.mode === "live" && models
      ? liveBadge(
          {
            capabilities: api.capabilities,
            contractVersion: api.contractVersion,
            defaultModel: models.defaultModel,
          },
          models,
        )
      : api.badge,
  );
}

export interface SidebarProps {
  route: Route;
  /** The list on show: the route's own, or the last one for Settings. */
  section: Section;
  onSwitchSection: (section: Section) => void;
  badge: ShellBadge;
  /** In the phone menu drawer: closes it, from a button after the New one. */
  onClose?: () => void;
}

/**
 * The sidebar (SPEC §3): brand and New button, the Bots/Tasks switch, the
 * section's list, then the mode badge, Settings and the theme toggle.
 */
export function Sidebar({
  route,
  section,
  onSwitchSection,
  badge,
  onClose,
}: SidebarProps) {
  const { bots, tasks } = useWorkspace();
  const { openNewBot, openNewTask } = useShell();
  const listLabelId = useId();

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
        {onClose && (
          <IconButton
            label="Close menu"
            tooltip={false}
            icon={<Icon name="close" size={16} />}
            onClick={onClose}
          />
        )}
      </div>

      {/* Only on a list screen is its item the current page; from Studio and
          Settings both items lead back to a list. */}
      <Segmented<Section | "elsewhere">
        kind="nav"
        label="Primary"
        value={
          route.name === "bots" || route.name === "tasks"
            ? section
            : "elsewhere"
        }
        onChange={(next) => {
          if (next !== "elsewhere") onSwitchSection(next);
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
          <>
            <TaskList labelledBy={listLabelId} />
            <TemplateList />
          </>
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
