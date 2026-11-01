import type { Bot, ConversationMessage } from "@jj/contracts";
import { Fragment, useLayoutEffect, useRef } from "react";
import { PixelSprite } from "../../components/sprite";
import {
  Avatar,
  Composer,
  DayDivider,
  ErrorBanner,
  TypingDots,
} from "../../components/ui";
import { formatMessageTime } from "../../lib/format";
import { useWorkspace } from "../../state/WorkspaceContext";
import type { InspectorFocus } from "./BotInspector";
import { groupByDay } from "./chat";
import { InlineTaskCard } from "./InlineTaskCard";

/** Within this many px of the bottom, new messages keep the log scrolled down. */
const STICK_PX = 80;

export interface BotConversationProps {
  bot: Bot;
  onOpenInspector: (focus: InspectorFocus) => void;
}

/** The scrolling chat column (About, messages, replying row) and the composer. */
export function BotConversation({
  bot,
  onOpenInspector,
}: BotConversationProps) {
  const { conversations, pendingBotTurns, sendBotMessage } = useWorkspace();
  const conversation = conversations[bot.id];
  const messages = conversation?.messages ?? [];
  const pending = pendingBotTurns[bot.id];
  const replying = Boolean(pending) || Boolean(conversation?.replying);
  // A previous reply's failure is stale while a new message is on its way.
  const replyError =
    conversation?.lastReplyError && !replying
      ? conversation.lastReplyError
      : null;
  const activity = replying
    ? `${bot.name} is replying`
    : bot.presence === "working"
      ? `${bot.name} is working`
      : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Keep the newest message in view unless the reader scrolled up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [messages.length, pending, replying, replyError, bot.presence]);

  return (
    <>
      <div
        ref={scrollRef}
        className="bot-chat"
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            STICK_PX;
        }}
      >
        <div className="bot-chat__column">
          <BotAbout bot={bot} onOpenInspector={onOpenInspector} />
          <div
            className="bot-chat__log"
            role="log"
            aria-label={`Messages with ${bot.name}`}
          >
            {groupByDay(messages).map((group) => (
              <Fragment key={group.key}>
                <DayDivider>{group.label}</DayDivider>
                {group.messages.map((message) => (
                  <ChatMessage key={message.id} bot={bot} message={message} />
                ))}
              </Fragment>
            ))}
            {conversation === undefined && (
              <p className="bot-chat__note">Loading messages…</p>
            )}
            {conversation && messages.length === 0 && !pending && (
              <p className="bot-chat__note">
                No messages yet. Say hello to {bot.name}.
              </p>
            )}
            {pending && <UserBubble text={pending} pending />}
          </div>
          {/* Always mounted, so screen readers announce each change of its text. */}
          <div className="bot-chat__activity" role="status" aria-live="polite">
            {activity && <ActivityRow bot={bot} label={activity} />}
          </div>
          {replyError && (
            <ErrorBanner word="Reply failed">{replyError.message}</ErrorBanner>
          )}
        </div>
      </div>
      <Composer
        key={bot.id}
        label={`Message ${bot.name}`}
        placeholder={`Message ${bot.name}…`}
        sending={Boolean(pending)}
        onSubmit={(text) => {
          stick.current = true;
          return sendBotMessage(bot.id, text);
        }}
      />
    </>
  );
}

/** The typing row (SPEC §4); its live region is the always-mounted parent. */
function ActivityRow({ bot, label }: { bot: Bot; label: string }) {
  return (
    <div className="ui-working">
      <PixelSprite appearance={bot.appearance} mood="working" size={24} />
      <span>{label}</span>
      <TypingDots />
    </div>
  );
}

function ChatMessage({
  bot,
  message,
}: {
  bot: Bot;
  message: ConversationMessage;
}) {
  if (message.role === "user")
    return <UserBubble text={message.text} createdAt={message.createdAt} />;
  return (
    <div className="chat-msg chat-msg--bot">
      <div className="chat-msg__head">
        <Avatar
          appearance={bot.appearance}
          name={bot.name}
          size={24}
          animate={false}
          decorative
        />
        <span className="chat-msg__author">{bot.name}</span>
        <time className="chat-msg__time" dateTime={message.createdAt}>
          {formatMessageTime(message.createdAt)}
        </time>
      </div>
      <p className="chat-msg__body">{message.text}</p>
      {message.taskId && <InlineTaskCard taskId={message.taskId} />}
    </div>
  );
}

function UserBubble({
  text,
  createdAt,
  pending = false,
}: {
  text: string;
  createdAt?: string;
  pending?: boolean;
}) {
  return (
    <div
      className="chat-msg chat-msg--user"
      data-pending={pending || undefined}
      // Announced once, when the stored message replaces it in the log.
      aria-hidden={pending || undefined}
    >
      <p className="chat-msg__bubble">
        <span className="visually-hidden">You: </span>
        {text}
      </p>
      {pending ? (
        <span className="chat-msg__time">sending…</span>
      ) : (
        createdAt && (
          <time className="chat-msg__time" dateTime={createdAt}>
            {formatMessageTime(createdAt)}
          </time>
        )
      )}
    </div>
  );
}

/** About (SPEC §5.1): portrait, name and role, instructions, tasks and memory links. */
function BotAbout({
  bot,
  onOpenInspector,
}: {
  bot: Bot;
  onOpenInspector: (focus: InspectorFocus) => void;
}) {
  const { memories } = useWorkspace();
  const memory = memories[bot.id];
  const activeTasks = bot.activeTaskIds.length;
  return (
    <section className="bot-about" aria-label={`About ${bot.name}`}>
      <Avatar
        appearance={bot.appearance}
        name={bot.name}
        size={48}
        animate={false}
        decorative
      />
      <div className="bot-about__title">
        <span className="bot-about__name">{bot.name}</span>
        {bot.role && <span className="bot-about__role">{bot.role}</span>}
      </div>
      {bot.instructions ? (
        <p className="bot-about__brief clamp2">{bot.instructions}</p>
      ) : (
        <p className="bot-about__brief bot-about__brief--empty">
          No instructions yet.
        </p>
      )}
      <div className="bot-about__links">
        <button
          type="button"
          className="text-link"
          onClick={() => onOpenInspector("tasks")}
        >
          {activeTasks} active {activeTasks === 1 ? "task" : "tasks"}
        </button>
        <button
          type="button"
          className="text-link"
          onClick={() => onOpenInspector("memory")}
        >
          {memory && !memory.text.trim() ? "no memory" : "memory"}
        </button>
      </div>
    </section>
  );
}
