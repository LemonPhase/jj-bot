import type { Bot, TaskMessage, TaskView } from "@jj/contracts";
import { useLayoutEffect, useRef, useState } from "react";
import type { ApiError } from "../../api/client";
import {
  Avatar,
  Button,
  Composer,
  cx,
  ErrorBanner,
  Mention,
  Tooltip,
  TypingDots,
} from "../../components/ui";
import { formatMessageTime } from "../../lib/format";
import { acceptsMessages, moodForStatus } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { ActivityText } from "./ActivityText";
import {
  type ActivityLine,
  activityLines,
  botName,
  mentionSegments,
  type TimelineEntry,
  taskTimeline,
} from "./taskModel";

/** Within this many px of the bottom, new messages keep the log scrolled down. */
const STICK_PX = 80;

/**
 * The task group chat (SPEC §5.2): attributed messages and notices, what each
 * bot is doing right now, and the composer. Every message steers the
 * coordinator; with "new goal" on it also replaces the goal.
 */
export function TaskChat({ view }: { view: TaskView }) {
  const { bots, getBot, postTaskMessage, pendingTaskSends, retryTask } =
    useWorkspace();
  const { task } = view;
  const [changingGoal, setChangingGoal] = useState(false);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  const pending = pendingTaskSends[task.id];
  const open = acceptsMessages(task);
  const stopping =
    Boolean(task.cancelRequestedAt) && task.status !== "cancelled";
  const timeline = taskTimeline(view);
  const lines = activityLines(view);
  const activityKey = lines
    .map((line) => `${line.session.id}:${line.text}`)
    .join("|");

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // Keep the newest message and activity in view unless the reader scrolled up.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [timeline.length, pending, activityKey, stopping]);

  const placeholder = !open
    ? stopping
      ? "This task is stopping"
      : "This task was stopped"
    : changingGoal
      ? `Write the new goal (v${task.goalVersion + 1})…`
      : "Message task group…";

  return (
    <>
      <div
        ref={scrollRef}
        className="task-chat"
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            STICK_PX;
        }}
      >
        <div className="task-chat__column">
          <div
            className="task-chat__log"
            role="log"
            aria-label={`Messages in ${task.title}`}
          >
            {timeline.length === 0 && !pending && (
              <p className="task-chat__note">
                No messages yet. Updates from the bots appear here.
              </p>
            )}
            {timeline.map((entry) => (
              <TimelineItem
                key={entry.kind === "notice" ? entry.id : entry.message.id}
                entry={entry}
                bots={bots}
                getBot={getBot}
              />
            ))}
            {pending && (
              <UserBubble
                text={pending.text}
                label={pending.changesGoal ? "new goal" : "steering"}
                goal={pending.changesGoal}
                pending
              />
            )}
            {stopping && (
              <p className="task-notice">
                Stopping… running sessions are being interrupted
              </p>
            )}
          </div>
          {/* Always mounted, so changes to the rows are announced. */}
          <ActivityList lines={lines} getBot={getBot} />
        </div>
      </div>
      {sendError && (
        <div className="task-chat__error">
          <SendError
            error={sendError}
            onRefresh={() => {
              setSendError(null);
              retryTask();
            }}
            onDismiss={() => setSendError(null)}
          />
        </div>
      )}
      <Composer
        key={task.id}
        variant="task"
        label="Message the task group"
        placeholder={placeholder}
        sending={Boolean(pending)}
        disabled={!open}
        leading={
          <Tooltip content="Send this message as the task's new goal">
            <Button
              size="lg"
              mono
              pressed={changingGoal}
              disabled={!open}
              onClick={() => setChangingGoal((on) => !on)}
            >
              new goal
            </Button>
          </Tooltip>
        }
        onSubmit={async (text) => {
          setSendError(null);
          stick.current = true;
          const result = await postTaskMessage(task.id, text, changingGoal);
          if (!result.ok) {
            setSendError(result.error);
            return false;
          }
          setChangingGoal(false);
          return true;
        }}
      />
    </>
  );
}

function TimelineItem({
  entry,
  bots,
  getBot,
}: {
  entry: TimelineEntry;
  bots: Bot[];
  getBot: (botId: string) => Bot | undefined;
}) {
  if (entry.kind === "notice")
    return <p className="task-notice">{entry.text}</p>;
  const { message, goalVersion } = entry;
  if (message.authorKind === "system")
    return <p className="task-notice">{message.text}</p>;
  if (message.authorKind === "user")
    return (
      <UserBubble
        text={message.text}
        createdAt={message.createdAt}
        goal={goalVersion !== null}
        label={
          goalVersion !== null
            ? `new goal · v${goalVersion}`
            : message.intent === "discussion"
              ? ""
              : message.intent
        }
      />
    );
  return <BotMessage message={message} bots={bots} getBot={getBot} />;
}

/** A user message: meta above, then the bubble (dashed when it steers). */
function UserBubble({
  text,
  label,
  createdAt,
  goal = false,
  pending = false,
}: {
  text: string;
  label: string;
  createdAt?: string;
  /** It replaced the goal: a solid bubble, like the goal it became. */
  goal?: boolean;
  pending?: boolean;
}) {
  const meta = [
    label,
    pending ? "sending…" : createdAt ? formatMessageTime(createdAt) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="task-msg task-msg--user"
      data-pending={pending || undefined}
    >
      <span className="task-msg__meta">
        <span>You</span>
        {createdAt && !pending ? (
          <time className="task-msg__time" dateTime={createdAt}>
            {meta}
          </time>
        ) : (
          <span className="task-msg__time">{meta}</span>
        )}
      </span>
      <p
        className={cx(
          "task-msg__bubble",
          !goal && label.startsWith("steering") && "task-msg__bubble--steer",
        )}
      >
        {text}
      </p>
    </div>
  );
}

const SHOWS_INTENT = new Set<TaskMessage["intent"]>([
  "assignment",
  "result",
  "notification",
  "steering",
]);

/** A bot message: sprite, name and `{intent} · {time}`, then the text with @mentions. */
function BotMessage({
  message,
  bots,
  getBot,
}: {
  message: TaskMessage;
  bots: Bot[];
  getBot: (botId: string) => Bot | undefined;
}) {
  const author = message.authorBotId ? getBot(message.authorBotId) : undefined;
  const segments = mentionSegments(message.text, bots);
  const mentioned = new Set(
    segments.flatMap((segment) => (segment.bot ? [segment.bot.id] : [])),
  );
  // Recipients the text does not already name, so an assignment always says who.
  const unnamed = message.recipientBotIds
    .filter((botId) => !mentioned.has(botId))
    .map((botId) => botName(getBot(botId)));
  const time = formatMessageTime(message.createdAt);
  return (
    <article
      className={cx("task-msg", "task-msg--bot", `task-msg--${message.intent}`)}
      aria-label={`${botName(author)}${SHOWS_INTENT.has(message.intent) ? `, ${message.intent}` : ""}`}
    >
      <div className="task-msg__head">
        <Avatar
          appearance={author?.appearance}
          name={botName(author)}
          size={24}
          animate={false}
          decorative
        />
        <span className="task-msg__author">{botName(author)}</span>
        <time className="task-msg__time" dateTime={message.createdAt}>
          {SHOWS_INTENT.has(message.intent)
            ? `${message.intent} · ${time}`
            : time}
          {unnamed.length > 0 && ` · to ${unnamed.join(", ")}`}
        </time>
      </div>
      <p className="task-msg__body">
        {segments.map((segment, index) =>
          segment.bot ? (
            <Mention key={index} colour={segment.bot.appearance.colour}>
              {segment.text}
            </Mention>
          ) : (
            segment.text
          ),
        )}
      </p>
    </article>
  );
}

/**
 * One row per bot still at work: sprite, name and what it is doing
 * ("Running `npm test`", "Waiting for you"). Rows stack, so several bots
 * working at once stay readable.
 */
function ActivityList({
  lines,
  getBot,
}: {
  lines: ActivityLine[];
  getBot: (botId: string) => Bot | undefined;
}) {
  return (
    <div className="task-activity" aria-live="polite">
      {lines.length > 0 && (
        <ul
          className="task-activity__list"
          aria-label="What the bots are doing"
        >
          {lines.map(({ session, text, working }) => {
            const bot = getBot(session.botId);
            return (
              <li key={session.id} className="task-activity__row">
                <Avatar
                  appearance={bot?.appearance}
                  name={botName(bot)}
                  mood={working ? "working" : moodForStatus(session)}
                  size={24}
                  decorative
                />
                <span className="task-activity__name">{botName(bot)}</span>
                <span className="task-activity__text clamp1" title={text}>
                  <ActivityText text={text} />
                </span>
                {working && <TypingDots />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Why a message was not sent, with the way forward. */
function SendError({
  error,
  onRefresh,
  onDismiss,
}: {
  error: ApiError;
  onRefresh: () => void;
  onDismiss: () => void;
}) {
  if (error.code === "STALE_GOAL_VERSION")
    return (
      <ErrorBanner word="Goal changed" onDismiss={onDismiss}>
        The goal changed since you last saw it, so your new goal was not sent.
        Refresh to load the current goal, then send again.{" "}
        <button type="button" className="text-link" onClick={onRefresh}>
          Refresh
        </button>
      </ErrorBanner>
    );
  return (
    <ErrorBanner word="Not sent" onDismiss={onDismiss}>
      {error.message}
    </ErrorBanner>
  );
}
