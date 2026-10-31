import { useState } from "react";
import { formatMessageTime } from "../../lib/format";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotAvatar } from "../common/BotAvatar";

export function BotList({ onNewBot }: { onNewBot: () => void }) {
  const { bots, conversations, selectedBotId, selectBot } = useWorkspace();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = bots.filter(
    (bot) =>
      bot.name.toLowerCase().includes(q) || bot.role.toLowerCase().includes(q),
  );

  return (
    <aside className="sidebar-list">
      <div className="sidebar-header">
        <input
          type="search"
          className="search-input"
          placeholder="Search bots..."
          aria-label="Search bots"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="add-btn"
          onClick={onNewBot}
          title="New bot"
          aria-label="New bot"
        >
          +
        </button>
      </div>
      <div className="list-scroll">
        {filtered.map((bot) => {
          const last = conversations[bot.id]?.messages.at(-1);
          return (
            <button
              key={bot.id}
              type="button"
              className={`bot-item ${bot.id === selectedBotId ? "active" : ""}`}
              onClick={() => selectBot(bot.id)}
            >
              <BotAvatar bot={bot} presence />
              <div className="item-body">
                <div className="item-top">
                  <span className="item-title">{bot.name}</span>
                  <span className="item-time">
                    {last ? formatMessageTime(last.createdAt) : ""}
                  </span>
                </div>
                <div className="item-subtitle">
                  {last ? last.text : bot.role}
                </div>
              </div>
            </button>
          );
        })}
        {filtered.length === 0 && (
          <p className="list-empty">
            {bots.length ? "No bots match your search." : "No bots yet."}
          </p>
        )}
      </div>
    </aside>
  );
}
