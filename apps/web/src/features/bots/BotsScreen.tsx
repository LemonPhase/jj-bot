import type { Bot } from "@jj/contracts";
import {
  type ReactNode,
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  Avatar,
  Button,
  buttonClass,
  EmptyState,
  ErrorBanner,
  Icon,
  IconButton,
  Panel,
  SectionLabel,
  Spinner,
  StatusTag,
} from "../../components/ui";
import { LoadBoundary, lazyComponent } from "../../lib/lazyComponent";
import { moodForStatus } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { botHref } from "../shell/router";
import { ScreenHeader } from "../shell/ScreenHeader";
import { useShell } from "../shell/ShellContext";
import { BotConversation } from "./BotConversation";
import type { BotInspectorProps, InspectorFocus } from "./BotInspector";
import { takeBotFocus } from "./focusRequest";
import "./bots.css";

/**
 * The bot's profile panel, a chunk of its own: it opens on demand, so the
 * first screen does not wait for it. The browser prefetches it once the page
 * has loaded (`prefetchChunks` in vite.config.ts), and it loads at boot when
 * it was left open (`preloadBotsScreen`).
 */
const inspector = lazyComponent("BotInspector", () =>
  import("./BotInspector").then((module) => module.BotInspector),
);

/**
 * Starts downloading what the Bots screen shows at once besides the chat: the
 * profile panel, when it was left open. Called at boot (`preloadScreen`).
 */
export function preloadBotsScreen(): void {
  if (readInspectorOpen()) inspector.load().catch(() => {});
}

/** `#/bots/:botId`: the selected bot's direct chat, or an empty state. */
export function BotsScreen({ botId }: { botId: string | null }) {
  const { bots } = useWorkspace();
  const { openNewBot } = useShell();
  const bot = botId ? bots.find((candidate) => candidate.id === botId) : null;

  if (bot) return <BotScreen key={bot.id} bot={bot} />;
  if (bots.length === 0) return <NoBots onNew={openNewBot} />;
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

/** The empty Bots screen; after the last bot is archived its action takes focus. */
function NoBots({ onNew }: { onNew: () => void }) {
  const actionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (takeBotFocus(null)) actionRef.current?.focus();
  }, []);
  return (
    <main className="screen screen--center">
      <EmptyState
        align="center"
        message="No bots yet. Create one to start chatting."
        action={
          <button
            ref={actionRef}
            type="button"
            className={buttonClass({ variant: "primary" })}
            onClick={onNew}
          >
            New bot
          </button>
        }
      />
    </main>
  );
}

const INSPECTOR_KEY = "jj.bots.inspector";

function readInspectorOpen(): boolean {
  try {
    return window.localStorage.getItem(INSPECTOR_KEY) === "open";
  } catch {
    return false;
  }
}

/** Whether the profile panel is open; remembered per browser, a convenience only. */
function useInspectorOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(readInspectorOpen);
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

  // Arriving here because the previous bot was archived: focus this bot.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (takeBotFocus(bot.id)) headingRef.current?.focus();
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
              <h1
                ref={headingRef}
                className="screen-title screen-title--bot"
                tabIndex={-1}
              >
                {bot.name}
              </h1>
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
        <LazyInspector
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

/** The profile panel, or its frame saying it is loading or did not load. */
function LazyInspector(props: BotInspectorProps) {
  const frame = (body: ReactNode) => (
    <Panel
      id={props.id}
      label={`${props.bot.name}'s profile`}
      className="bot-inspector"
    >
      <div className="bot-inspector__head">
        <SectionLabel as="h2">Profile</SectionLabel>
        <IconButton
          label="Close profile"
          icon={<Icon name="close" size={16} />}
          onClick={props.onClose}
        />
      </div>
      {body}
    </Panel>
  );
  return (
    <LoadBoundary
      failed={(error) =>
        frame(
          <>
            <ErrorBanner word="Couldn't load">
              {`the profile: ${error.message}`}
            </ErrorBanner>
            <div className="inspector-actions">
              <Button onClick={() => window.location.reload()}>Reload</Button>
            </div>
          </>,
        )
      }
    >
      <Suspense
        fallback={frame(<Spinner label="Loading profile…" showLabel />)}
      >
        <inspector.Component {...props} />
      </Suspense>
    </LoadBoundary>
  );
}
