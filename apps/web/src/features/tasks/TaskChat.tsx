import type {
  Artifact,
  Bot,
  ExecutionSession,
  TaskMessage,
  TaskView,
} from "@jj/contracts";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApi } from "../../api/ApiContext";
import type { ApiError } from "../../api/client";
import {
  Avatar,
  Button,
  Composer,
  cx,
  ErrorBanner,
  Icon,
  IconButton,
  Mention,
  Tooltip,
  TypingDots,
} from "../../components/ui";
import { formatMessageTime } from "../../lib/format";
import { acceptsMessages, moodForStatus } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { ActivityText } from "./ActivityText";
import { ApprovalCard } from "./ApprovalCard";
import { coordinatorHolds } from "./approvals";
import {
  type ActivityLine,
  activityLines,
  botName,
  createMentionMatcher,
  type MentionSegment,
  statusAnnouncements,
  type TimelineEntry,
  taskTimeline,
} from "./taskModel";
import {
  FileInput,
  UploadCard,
  UploadDraftList,
  uploadsByMessage,
  useDiscardOnUnmount,
  useUploadDrafts,
} from "./uploads";

/** Within this many px of the bottom, new messages keep the log scrolled down. */
const STICK_PX = 80;

/**
 * The task group chat (SPEC §5.2): attributed messages and notices, what each
 * bot is doing right now, and the composer. Every message steers the
 * coordinator; with "new goal" on it also replaces the goal. The paperclip
 * picks files to upload into the workspace, alone or with the next message.
 */
export function TaskChat({ view }: { view: TaskView }) {
  const { bots, getBot, postTaskMessage, pendingTaskSends, retryTask } =
    useWorkspace();
  const api = useApi();
  const { task } = view;
  const [changingGoal, setChangingGoal] = useState(false);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  const pending = pendingTaskSends[task.id];
  const open = acceptsMessages(task);
  const stopping =
    Boolean(task.cancelRequestedAt) && task.status !== "cancelled";
  const { messages, events, sessions } = view;
  const timeline = useMemo(
    () => taskTimeline({ ...view, messages, events }),
    [messages, events],
  );
  const lines = useMemo(
    () => activityLines({ ...view, sessions }),
    [task.status, sessions],
  );
  const mention = useMemo(() => createMentionMatcher(bots), [bots]);
  const uploads = useUploadDrafts();
  // Files picked and left unsent are removed when the chat moves on.
  useDiscardOnUnmount(uploads, task.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const canUpload = Boolean(uploads.limits) && open;
  const uploadedBy = useMemo(
    () => uploadsByMessage(view.artifacts),
    [view.artifacts],
  );
  /** Attaches the staged files; true once they are (or when there are none). */
  const attach = async (): Promise<boolean> => {
    if (uploads.uploading) {
      setUploadError("Wait until every file has uploaded.");
      return false;
    }
    if (uploads.entries.length === 0) return true;
    setAttaching(true);
    setUploadError(null);
    try {
      await api.uploadToTask(task.id, { files: uploads.entries });
      uploads.clear();
      return true;
    } catch (reason) {
      setUploadError(
        reason instanceof Error
          ? reason.message
          : "Could not upload the files.",
      );
      return false;
    } finally {
      setAttaching(false);
    }
  };
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

  // The coordinator reads a message only with its approval's answer.
  const holding = coordinatorHolds(view);
  const placeholder = !open
    ? stopping
      ? "This task is stopping"
      : "This task was stopped"
    : changingGoal
      ? `Write the new goal (v${task.goalVersion + 1})…`
      : holding
        ? "Answer the approval above; a message waits for it…"
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
                key={
                  entry.kind === "notice"
                    ? entry.id
                    : entry.kind === "approval"
                      ? entry.approval.id
                      : entry.message.id
                }
                entry={entry}
                mention={mention}
                getBot={getBot}
                taskId={task.id}
                files={
                  entry.kind === "message"
                    ? uploadedBy.get(entry.message.id)
                    : undefined
                }
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
          {lines.length > 0 && <ActivityList lines={lines} getBot={getBot} />}
          <StatusAnnouncer sessions={sessions} getBot={getBot} />
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
      {(uploads.drafts.length > 0 || uploadError) && (
        <div className="task-chat__uploads">
          <UploadDraftList uploads={uploads} disabled={attaching} />
          {uploadError && (
            <ErrorBanner
              word="Not uploaded"
              onDismiss={() => setUploadError(null)}
            >
              {uploadError}
            </ErrorBanner>
          )}
          {uploads.entries.length > 0 && (
            <div className="task-chat__uploads-actions">
              <span className="task-chat__uploads-hint">
                Sent with your next message, or on their own:
              </span>
              <Button
                size="sm"
                disabled={uploads.uploading || attaching}
                onClick={() => void attach()}
              >
                {attaching
                  ? "Uploading…"
                  : `Upload ${uploads.entries.length === 1 ? "1 file" : `${uploads.entries.length} files`}`}
              </Button>
            </div>
          )}
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
          <>
            {canUpload && (
              <>
                <IconButton
                  label="Attach files"
                  tooltip="Upload files into the task's workspace"
                  size="lg"
                  icon={<Icon name="paperclip" size={16} />}
                  disabled={attaching}
                  onClick={() => fileInput.current?.click()}
                />
                <FileInput
                  ref={fileInput}
                  label="Files to upload into the task"
                  onFiles={(files) => {
                    setUploadError(null);
                    uploads.add(files);
                  }}
                />
              </>
            )}
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
          </>
        }
        onSubmit={async (text) => {
          setSendError(null);
          stick.current = true;
          // Files picked first go in with the message, ahead of it.
          if (!(await attach())) return false;
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
  mention,
  getBot,
  taskId,
  files,
}: {
  entry: TimelineEntry;
  mention: (text: string) => MentionSegment[];
  getBot: (botId: string) => Bot | undefined;
  taskId: string;
  /** The files a user announcement attached. */
  files?: readonly Artifact[];
}) {
  if (entry.kind === "notice")
    return <p className="task-notice">{entry.text}</p>;
  if (entry.kind === "approval")
    return (
      <ApprovalCard
        approval={entry.approval}
        bot={getBot(entry.approval.botId)}
      />
    );
  const { message, goalVersion } = entry;
  if (message.authorKind === "system")
    return <p className="task-notice">{message.text}</p>;
  if (message.authorKind === "user" && files && files.length > 0)
    return <UploadCard taskId={taskId} message={message} files={files} />;
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
  return <BotMessage message={message} mention={mention} getBot={getBot} />;
}

/** A user message: meta above, then the bubble (dashed when it steers). Memoised. */
const UserBubble = memo(function UserBubble({
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
});

const SHOWS_INTENT = new Set<TaskMessage["intent"]>([
  "assignment",
  "result",
  "notification",
  "steering",
]);

/** A bot message: sprite, name and `{intent} · {time}`, then the text with @mentions. */
const BotMessage = memo(function BotMessage({
  message,
  mention,
  getBot,
}: {
  message: TaskMessage;
  mention: (text: string) => MentionSegment[];
  getBot: (botId: string) => Bot | undefined;
}) {
  const author = message.authorBotId ? getBot(message.authorBotId) : undefined;
  const segments = mention(message.text);
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
});

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
    <ul className="task-activity__list" aria-label="What the bots are doing">
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
  );
}

/**
 * Announces only the transitions that matter (a bot waiting, finished,
 * failed or stopped), from an always-mounted status region, instead of every
 * "Thinking…" or "Running…" line the rows above show.
 */
function StatusAnnouncer({
  sessions,
  getBot,
}: {
  sessions: readonly ExecutionSession[];
  getBot: (botId: string) => Bot | undefined;
}) {
  const seen = useRef<Map<string, ExecutionSession["status"]> | null>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    const previous = seen.current;
    seen.current = new Map(sessions.map((s) => [s.id, s.status]));
    // The first view sets the baseline; nothing has changed yet.
    if (!previous) return;
    const lines = statusAnnouncements(previous, sessions, (botId) =>
      botName(getBot(botId)),
    );
    if (lines.length) setSaid(`${lines.join(". ")}.`);
  }, [sessions, getBot]);
  return (
    <p className="visually-hidden" role="status" aria-live="polite">
      {said}
    </p>
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
