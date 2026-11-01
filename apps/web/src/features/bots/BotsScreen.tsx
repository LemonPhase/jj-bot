import type { Bot } from "@jj/contracts";
import { useEffect, useId, useRef, useState } from "react";
import {
  Avatar,
  Button,
  buttonClass,
  EmptyState,
  Icon,
  IconButton,
  StatusTag,
} from "../../components/ui";
import { moodForStatus } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { botHref } from "../shell/router";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useShell } from "../shell/ShellContext";
import { BotConversation } from "./BotConversation";
import { BotInspector, type InspectorFocus } from "./BotInspector";
import "./bots.css";

/** `#/bots/:botId`: the selected bot's direct chat, or an empty state. */
export function BotsScreen({ botId }: { botId: string | null }) {
  const { bots } = useWorkspace();
  const { openNewBot } = useShell();
  const bot = botId ? bots.find((candidate) => candidate.id === botId) : null;

  if (bot) return <BotScreen key={bot.id} bot={bot} />;
  if (bots.length === 0)
    return (
      <main className="screen screen--center">
        <EmptyState
          align="center"
          message="No bots yet. Create one to start chatting."
          action={
            <Button variant="primary" onClick={openNewBot}>
              New bot
            </Button>
          }
        />
      </main>
    );
  // No id yet: the shell is about to open the first bot.
  if (!botId) return <main className="screen" />;
  const first = bots[0];
  return (
    <main className="screen screen--center">
      <EmptyState
        align="center"
        message="This bot does not exist or was archived."
        action={
          first && (
            <a
              className={buttonClass({ variant: "primary" })}
              href={botHref(first.id)}
            >
              Open {first.name}
            </a>
          )
        }
      />
    </main>
  );
}

const INSPECTOR_KEY = "jj.bots.inspector";

/** Whether the profile panel is open; remembered per browser, a convenience only. */
function useInspectorOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(INSPECTOR_KEY) === "open";
    } catch {
      return false;
    }
  });
  const update = (next: boolean) => {
    setOpen(next);
    try {
      window.localStorage.setItem(INSPECTOR_KEY, next ? "open" : "closed");
    } catch {}
  };
  return [open, update];
}

function BotScreen({ bot }: { bot: Bot }) {
  const { loadMemory } = useWorkspace();
  const { openNewTask } = useShell();
  const [inspectorOpen, setInspectorOpen] = useInspectorOpen();
  const [focus, setFocus] = useState<InspectorFocus | null>(null);
  const toggleId = useId();
  const inspectorId = useId();

  // Once per bot (`loadMemory` changes identity on every workspace update).
  const loadMemoryRef = useRef(loadMemory);
  loadMemoryRef.current = loadMemory;
  useEffect(() => {
    void loadMemoryRef.current(bot.id);
  }, [bot.id]);

  const openInspector = (target: InspectorFocus) => {
    setInspectorOpen(true);
    setFocus(target);
  };
  const closeInspector = () => {
    setInspectorOpen(false);
    document.getElementById(toggleId)?.focus();
  };

  return (
    <div className="bots-screen">
      <main className="bot-main" aria-label={`Chat with ${bot.name}`}>
        <ScreenHeader
          lead={
            <>
              <Avatar
                appearance={bot.appearance}
                name={bot.name}
                mood={moodForStatus(bot.presence)}
                size={24}
                decorative
              />
              <h1 className="screen-title screen-title--bot">{bot.name}</h1>
              <StatusTag size="lg" status={bot.presence} />
            </>
          }
          actions={
            <>
              <Button onClick={() => openNewTask([bot.id])}>New task</Button>
              <IconButton
                id={toggleId}
                label="Profile"
                icon={<Icon name="panel" size={17} />}
                pressed={inspectorOpen}
                aria-controls={inspectorOpen ? inspectorId : undefined}
                onClick={() =>
                  inspectorOpen ? closeInspector() : setInspectorOpen(true)
                }
              />
            </>
          }
        />
        <BotConversation bot={bot} onOpenInspector={openInspector} />
      </main>
      {inspectorOpen && (
        <BotInspector
          id={inspectorId}
          bot={bot}
          focus={focus}
          onFocused={() => setFocus(null)}
          onClose={closeInspector}
        />
      )}
    </div>
  );
}
