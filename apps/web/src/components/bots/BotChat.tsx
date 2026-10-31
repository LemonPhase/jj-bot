import type { Bot } from "@jj/contracts";
import { useEffect, useRef } from "react";
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
  bot: Bot;
  onNewTask: () => void;
  onToggleInspector: () => void;
}) {
  const { conversations, sendBotMessage, pendingBotTurns, tasks } =
    useWorkspace();
  const conversation = conversations[bot.id];
  const messages = conversation?.messages ?? [];
  const replyError = conversation?.lastReplyError;
  const pendingText = pendingBotTurns[bot.id];
  const lastTaskId = [...messages].reverse().find((m) => m.taskId)?.taskId;
  const linkedTask = lastTaskId
    ? tasks.find((task) => task.id === lastTaskId)
    : undefined;
  const taskRunning =
    linkedTask?.status === "running" || linkedTask?.status === "queued";
  const busy =
    Boolean(pendingText) || Boolean(conversation?.replying) || taskRunning;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pendingText, busy, replyError, bot.id]);

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
        {replyError && !conversation?.replying && (
          <div className="msg-row system" role="alert">
            <div className="system-pill">
              Reply failed: {replyError.message}
            </div>
          </div>
        )}
        {busy && (
          <TypingIndicator
            avatar={<BotAvatar bot={bot} size="sm" />}
            label={
              conversation?.replying
                ? `${bot.name} is replying…`
                : `${bot.name} is working…`
            }
          />
        )}
      </div>

      <Composer
        key={bot.id}
        placeholder={`Message ${bot.name}...`}
        disabled={Boolean(pendingText)}
        onSend={(text) => void sendBotMessage(bot.id, text)}
      />
    </main>
  );
}
