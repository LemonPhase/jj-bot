import {
  Avatar,
  Button,
  EmptyState,
  ListItem,
  StatusSquare,
} from "../../components/ui";
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
          <li key={bot.id}>
            <ListItem
              data-list-item=""
              tabIndex={index === stop ? 0 : -1}
              selected={bot.id === selectedBotId}
              aria-current={bot.id === selectedBotId ? "page" : undefined}
              onClick={() => navigate({ name: "bots", botId: bot.id })}
              leading={
                <Avatar
                  appearance={bot.appearance}
                  name={bot.name}
                  mood={activity.mood}
                  size={36}
                  decorative
                />
              }
              title={bot.name}
              subtitle={
                <>
                  <StatusSquare tone={activity.tone} />
                  <span className="clamp1">{activity.text}</span>
                </>
              }
            />
          </li>
        );
      })}
    </ul>
  );
}
