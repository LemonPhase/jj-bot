import { useEffect, useRef, useState } from "react";
import type { TaskView } from "../../api/types";
import { formatMessageTime } from "../../lib/format";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotAvatar } from "../common/BotAvatar";
import { Composer } from "../common/Composer";
import { StatusDot } from "../common/StatusDot";
import { TypingIndicator } from "../common/TypingIndicator";

const STOPPABLE = new Set<TaskView["status"]>(["queued", "running", "waiting"]);

export function TaskChat({ task }: { task: TaskView }) {
  const { getBot, jumpToBot, postTaskMessage, stopTask, pendingTaskSends } =
    useWorkspace();
  const [steering, setSteering] = useState(false);
  const pending = pendingTaskSends[task.id];
  const coordinator = getBot(task.coordinatorBotId);
  const busy =
    Boolean(pending) || task.status === "running" || task.status === "queued";
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task.messages.length, task.id, pending, busy]);

  return (
    <main className="chat-column">
      <header className="pane-header">
        <div className="pane-header-left">
          <div className="pane-title-group">
            <div className="pane-title">
              <span className="pane-title-text">{task.goal}</span>
              <span className="status-pill">
                <StatusDot status={task.status} />
                {task.status} · v{task.goalVersion}
              </span>
            </div>
          </div>
        </div>
        <div className="header-actions">
          {STOPPABLE.has(task.status) && (
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
              <StatusDot color={bot.color} />
              <span>{bot.name}</span>
              {isCoordinator && <span className="chip-note">coord</span>}
            </button>
          );
        })}
      </div>

      <div className="messages-scroll" ref={scrollRef}>
        {task.messages.length === 0 && !pending && (
          <div className="msg-row system">
            <div className="system-pill">
              No messages yet · updates from the bots will appear here
            </div>
          </div>
        )}
        {task.messages.map((m) => {
          if (m.authorKind === "system") {
            return (
              <div key={m.id} className="msg-row system">
                <div className="system-pill">{m.text}</div>
              </div>
            );
          }
          const isUser = m.authorKind === "user";
          const bot = isUser ? undefined : getBot(m.authorId);
          return (
            <div
              key={m.id}
              className={`msg-row ${isUser ? "user" : "bot"} ${m.intent === "steering" ? "steering-msg" : ""}`}
            >
              {bot && <BotAvatar bot={bot} size="sm" />}
              <div className="msg-content-wrap">
                <div className="msg-sender">
                  <span>{isUser ? "You" : (bot?.name ?? m.authorId)}</span>
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
        {pending && (
          <div
            className={`msg-row user pending ${pending.steering ? "steering-msg" : ""}`}
          >
            <div className="msg-content-wrap">
              <div className="msg-sender">
                <span>You</span>
                {pending.steering && (
                  <span className="intent-tag steering">steering</span>
                )}
                <span>Sending…</span>
              </div>
              <div className="msg-bubble">{pending.text}</div>
            </div>
          </div>
        )}
        {busy && (
          <TypingIndicator
            avatar={
              coordinator ? (
                <BotAvatar bot={coordinator} size="sm" />
              ) : undefined
            }
            label={
              pending
                ? "Sending to the team…"
                : `${coordinator?.name ?? "The coordinator"} is working…`
            }
          />
        )}
      </div>

      <Composer
        key={task.id}
        placeholder={
          steering
            ? "Steer task goal & notify active sessions..."
            : "Message task group..."
        }
        disabled={Boolean(pending)}
        leading={
          <button
            type="button"
            className={`mode-chip ${steering ? "steer-active" : ""}`}
            aria-pressed={steering}
            onClick={() => setSteering((on) => !on)}
          >
            Steer
          </button>
        }
        onSend={(text) => {
          void postTaskMessage(task.id, text, steering);
          setSteering(false);
        }}
      />
    </main>
  );
}
