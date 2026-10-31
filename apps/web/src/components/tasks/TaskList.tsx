import { useState } from "react";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotAvatar } from "../common/BotAvatar";
import { StatusDot } from "../common/StatusDot";

export function TaskList({ onNewTask }: { onNewTask: () => void }) {
  const { tasks, selectedTaskId, selectTask, getBot } = useWorkspace();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = tasks.filter((task) => task.goal.toLowerCase().includes(q));

  return (
    <aside className="sidebar-list">
      <div className="sidebar-header">
        <input
          type="search"
          className="search-input"
          placeholder="Search tasks..."
          aria-label="Search tasks"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="add-btn"
          onClick={onNewTask}
          title="New task"
          aria-label="New task"
        >
          +
        </button>
      </div>
      <div className="list-scroll">
        {filtered.map((task) => (
          <button
            key={task.id}
            type="button"
            className={`task-item ${task.id === selectedTaskId ? "active" : ""}`}
            onClick={() => selectTask(task.id)}
          >
            <StatusDot status={task.status} />
            <div className="item-body">
              <div className="item-top">
                <span className="item-title">{task.goal}</span>
                <span className="item-time">v{task.goalVersion}</span>
              </div>
              <div className="item-top item-bottom">
                <span className="item-subtitle">
                  {task.status} · {task.sessions.length} sessions
                </span>
                <div className="avatar-stack">
                  {task.participantBotIds.map((botId) => {
                    const bot = getBot(botId);
                    return bot ? (
                      <BotAvatar key={botId} bot={bot} size="sm" />
                    ) : null;
                  })}
                </div>
              </div>
            </div>
          </button>
        ))}
        {filtered.length === 0 && (
          <p className="list-empty">
            {tasks.length ? "No tasks match your search." : "No tasks yet."}
          </p>
        )}
      </div>
    </aside>
  );
}
