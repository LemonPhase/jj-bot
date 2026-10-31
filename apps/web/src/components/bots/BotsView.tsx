import { useState } from "react";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotChat } from "./BotChat";
import { BotInspector } from "./BotInspector";
import { BotList } from "./BotList";

export function BotsView({
  onNewBot,
  onNewTask,
}: {
  onNewBot: () => void;
  /** Opens the new-task modal with these bots preselected. */
  onNewTask: (botIds: string[]) => void;
}) {
  const { selectedBotId, getBot } = useWorkspace();
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const bot = selectedBotId ? getBot(selectedBotId) : undefined;

  return (
    <section
      className={`view-pane bots-layout active ${inspectorOpen && bot ? "" : "hide-inspector"}`}
      aria-label="Bots"
    >
      <BotList onNewBot={onNewBot} />
      {bot ? (
        <>
          <BotChat
            bot={bot}
            onNewTask={() => onNewTask([bot.id])}
            onToggleInspector={() => setInspectorOpen((open) => !open)}
          />
          {inspectorOpen && <BotInspector key={bot.id} bot={bot} />}
        </>
      ) : (
        <main className="chat-column empty-state">
          <p>Create a bot to start chatting.</p>
        </main>
      )}
    </section>
  );
}
