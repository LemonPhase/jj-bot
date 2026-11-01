import type { TaskView } from "@jj/contracts";
import { useEffect, useRef, useState } from "react";
import {
  Avatar,
  Composer,
  StatusSquare,
  WorkingIndicator,
} from "../../components/ui";
import { formatMessageTime } from "../../lib/format";
import {
  acceptsMessages,
  isStoppable,
  statusTone,
  statusWord,
} from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";

export function TaskChat({ view }: { view: TaskView }) {
  const { getBot, jumpToBot, postTaskMessage, stopTask, pendingTaskSends } =
    useWorkspace();
  const { task, messages } = view;
  const [changingGoal, setChangingGoal] = useState(false);
  const pending = pendingTaskSends[task.id];
  const coordinator = getBot(task.coordinatorBotId);
  const working = task.status === "running" || task.status === "queued";
  const busy = Boolean(pending) || (working && !task.cancelRequestedAt);
  const open = acceptsMessages(task);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, task.id, pending, busy]);

  return (
    <main className="chat-column">
      <header className="pane-header">
        <div className="pane-header-left">
          <div className="pane-title-group">
            <div className="pane-title">
              <span className="pane-title-text" title={task.goal}>
                {task.title}
              </span>
              <span className="status-pill">
                <StatusSquare tone={statusTone(task)} />
                {statusWord(task)} · v{task.goalVersion}
              </span>
            </div>
          </div>
        </div>
        <div className="header-actions">
          {isStoppable(task) && (
            <button
              type="button"
              className="action-btn danger"
              onClick={() => void stopTask(task.id)}
            >
              Stop
            </button>
          )}
        </div>
      </header>

      <div className="participant-strip" aria-label="Participants">
        {task.participantBotIds.map((botId) => {
          const bot = getBot(botId);
          if (!bot) return null;
          const isCoordinator = botId === task.coordinatorBotId;
          return (
            <button
              key={botId}
              type="button"
              className={`bot-chip ${isCoordinator ? "coordinator" : ""}`}
              onClick={() => jumpToBot(botId)}
            >
              <Avatar
                appearance={bot.appearance}
                name={bot.name}
                size={18}
                animate={false}
                decorative
              />
              <span>{bot.name}</span>
              {isCoordinator && <span className="chip-note">coord</span>}
            </button>
          );
        })}
      </div>

      <div className="messages-scroll" ref={scrollRef}>
        {messages.length === 0 && !pending && (
          <div className="msg-row system">
            <div className="system-pill">
              No messages yet · updates from the bots will appear here
            </div>
          </div>
        )}
        {messages.map((m) => {
          if (m.authorKind === "system") {
            return (
              <div key={m.id} className="msg-row system">
                <div className="system-pill">{m.text}</div>
              </div>
            );
          }
          const isUser = m.authorKind === "user";
          const bot = m.authorBotId ? getBot(m.authorBotId) : undefined;
          return (
            <div
              key={m.id}
              className={`msg-row ${isUser ? "user" : "bot"} ${m.intent === "steering" ? "steering-msg" : ""}`}
            >
              {bot && (
                <Avatar
                  appearance={bot.appearance}
                  name={bot.name}
                  size={24}
                  animate={false}
                  decorative
                />
              )}
              <div className="msg-content-wrap">
                <div className="msg-sender">
                  <span>{isUser ? "You" : (bot?.name ?? "Bot")}</span>
                  {m.intent !== "discussion" && (
                    <span className={`intent-tag ${m.intent}`}>{m.intent}</span>
                  )}
                  <span>{formatMessageTime(m.createdAt)}</span>
                </div>
                <div className="msg-bubble">{m.text}</div>
              </div>
            </div>
          );
        })}
        {task.cancelRequestedAt && task.status !== "cancelled" && (
          <div className="msg-row system">
            <div className="system-pill">Stopping…</div>
          </div>
        )}
        {pending && (
          <div
            className={`msg-row user pending ${pending.changesGoal ? "steering-msg" : ""}`}
          >
            <div className="msg-content-wrap">
              <div className="msg-sender">
                <span>You</span>
                {pending.changesGoal && (
                  <span className="intent-tag steering">new goal</span>
                )}
                <span>Sending…</span>
              </div>
              <div className="msg-bubble">{pending.text}</div>
            </div>
          </div>
        )}
        {busy && (
          <WorkingIndicator
            name={coordinator?.name ?? "The coordinator"}
            appearance={coordinator?.appearance}
            label={pending ? "Sending to the coordinator" : undefined}
          />
        )}
      </div>

      <Composer
        key={task.id}
        variant="task"
        label="Message the task"
        placeholder={
          !open
            ? "This task was stopped"
            : changingGoal
              ? "Replace the task goal…"
              : "Message the coordinator…"
        }
        sending={Boolean(pending)}
        disabled={!open}
        leading={
          <button
            type="button"
            className={`mode-chip ${changingGoal ? "steer-active" : ""}`}
            aria-pressed={changingGoal}
            title="Send this message as the task's new goal"
            disabled={!open}
            onClick={() => setChangingGoal((on) => !on)}
          >
            New goal
          </button>
        }
        onSubmit={(text) => {
          void postTaskMessage(task.id, text, changingGoal);
          setChangingGoal(false);
        }}
      />
    </main>
  );
}
