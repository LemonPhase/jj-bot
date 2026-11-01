import type { Bot } from "@jj/contracts";
import { memo } from "react";
import {
  Avatar,
  Button,
  EmptyState,
  ListItem,
  StatusSquare,
} from "../../components/ui";
import type { Mood, StatusTone } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { tabStopIndex, useListKeyboard } from "../shell/listNavigation";
import { useShell } from "../shell/ShellContext";
import { navigate } from "../shell/useRoute";
import { botActivity } from "./botActivity";

/** The sidebar bot list (SPEC §3): 36px sprites in their mood, name and status line. */
export function BotList({ labelledBy }: { labelledBy: string }) {
  const { bots, tasks, loading, loadError, selectedBotId } = useWorkspace();
  const { openNewBot } = useShell();
  const onKeyDown = useListKeyboard();

  if (loading) return <p className="shell-list__note">Loading…</p>;
  if (loadError) return <p className="shell-list__note">Not loaded.</p>;
  if (bots.length === 0)
    return (
      <EmptyState
        message="No bots yet."
        action={
          <Button variant="primary" onClick={openNewBot}>
            New bot
          </Button>
        }
      />
    );

  const stop = tabStopIndex(
    bots.findIndex((bot) => bot.id === selectedBotId),
    bots.length,
  );
  return (
    <ul className="ui-list" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {bots.map((bot, index) => {
        const activity = botActivity(bot, tasks);
        return (
          <BotRow
            key={bot.id}
            bot={bot}
            mood={activity.mood}
            tone={activity.tone}
            text={activity.text}
            selected={bot.id === selectedBotId}
            tabStop={index === stop}
          />
        );
      })}
    </ul>
  );
}

/** One bot row; memoised, so task updates re-render only rows whose status changed. */
const BotRow = memo(function BotRow({
  bot,
  mood,
  tone,
  text,
  selected,
  tabStop,
}: {
  bot: Bot;
  mood: Mood;
  tone: StatusTone;
  text: string;
  selected: boolean;
  tabStop: boolean;
}) {
  return (
    <li>
      <ListItem
        data-list-item=""
        tabIndex={tabStop ? 0 : -1}
        selected={selected}
        aria-current={selected ? "page" : undefined}
        onClick={() => navigate({ name: "bots", botId: bot.id })}
        leading={
          <Avatar
            appearance={bot.appearance}
            name={bot.name}
            mood={mood}
            size={36}
            decorative
          />
        }
        title={bot.name}
        subtitle={
          <>
            <StatusSquare tone={tone} />
            <span className="clamp1">{text}</span>
          </>
        }
      />
    </li>
  );
});
