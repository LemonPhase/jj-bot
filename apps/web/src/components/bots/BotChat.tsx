import { useEffect, useRef } from "react";
import type { BotProfile } from "../../api/types";
import { formatMessageTime } from "../../lib/format";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotAvatar } from "../common/BotAvatar";
import { Composer } from "../common/Composer";
import { TypingIndicator } from "../common/TypingIndicator";
import { InlineTaskCard } from "./InlineTaskCard";

export function BotChat({
  bot,
  onNewTask,
  onToggleInspector,
}: {
  bot: BotProfile;
  onNewTask: () => void;
  onToggleInspector: () => void;
}) {
  const { conversations, sendDirectMessage, pendingBotTurns, tasks } =
    useWorkspace();
  const messages = conversations[bot.id] ?? [];
  const pendingText = pendingBotTurns[bot.id];
  const lastTaskId = [...messages].reverse().find((m) => m.taskId)?.taskId;
  const linkedTask = lastTaskId
    ? tasks.find((task) => task.id === lastTaskId)
    : undefined;
  const taskRunning =
    linkedTask?.status === "running" || linkedTask?.status === "queued";
  const busy = Boolean(pendingText) || taskRunning;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pendingText, busy, bot.id]);

  return (
    <main className="chat-column">
      <header className="pane-header">
        <div className="pane-header-left">
          <BotAvatar bot={bot} size="sm" />
          <div className="pane-title-group">
            <div className="pane-title">{bot.name}</div>
            <div className="pane-meta">{bot.role}</div>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" className="action-btn" onClick={onNewTask}>
            + Task
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={onToggleInspector}
            title="Toggle bot settings"
            aria-label="Toggle bot settings"
          >
            ☰
          </button>
        </div>
      </header>

      <div className="messages-scroll" ref={scrollRef}>
        {messages.length === 0 && !pendingText && (
          <div className="msg-row system">
            <div className="system-pill">
              Start a conversation with {bot.name}
            </div>
          </div>
        )}
        {messages.map((m) => {
          if (m.role === "system") {
            return (
              <div key={m.id} className="msg-row system">
                <div className="system-pill">{m.text}</div>
              </div>
            );
          }
          const isUser = m.role === "user";
          return (
            <div key={m.id} className={`msg-row ${isUser ? "user" : "bot"}`}>
              {!isUser && <BotAvatar bot={bot} size="sm" />}
              <div className="msg-content-wrap">
                <div className="msg-bubble">{m.text}</div>
                {m.taskId && <InlineTaskCard taskId={m.taskId} />}
                <div className="msg-sender">
                  {formatMessageTime(m.createdAt)}
                </div>
              </div>
            </div>
          );
        })}
        {pendingText && (
          <div className="msg-row user pending">
            <div className="msg-content-wrap">
              <div className="msg-bubble">{pendingText}</div>
              <div className="msg-sender">Sending…</div>
            </div>
          </div>
        )}
        {busy && (
          <TypingIndicator
            avatar={<BotAvatar bot={bot} size="sm" />}
            label={`${bot.name} is working…`}
          />
        )}
      </div>

      <Composer
        key={bot.id}
        placeholder={`Message ${bot.name}...`}
        disabled={Boolean(pendingText)}
        onSend={(text) => void sendDirectMessage(bot.id, text)}
      />
    </main>
  );
}
