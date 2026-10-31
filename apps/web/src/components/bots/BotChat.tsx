import { useEffect, useRef } from "react";
import type { BotProfile } from "../../api/types";
import { formatMessageTime } from "../../lib/format";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotAvatar } from "../common/BotAvatar";
import { Composer } from "../common/Composer";
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
  const { conversations, sendDirectMessage } = useWorkspace();
  const messages = conversations[bot.id] ?? [];
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, bot.id]);

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
        {messages.length === 0 && (
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
      </div>

      <Composer
        key={bot.id}
        placeholder={`Message ${bot.name}...`}
        onSend={(text) => void sendDirectMessage(bot.id, text)}
      />
    </main>
  );
}
