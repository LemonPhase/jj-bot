import { useState } from "react";
import { useApi } from "../../api/ApiContext";
import { BOT_COLORS, BOT_GLYPHS, type BotProfile } from "../../api/types";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotAvatar } from "../common/BotAvatar";
import { StatusDot } from "../common/StatusDot";

/** Bot settings. Mount with `key={bot.id}` so drafts reset per bot. */
export function BotInspector({ bot }: { bot: BotProfile }) {
  const { tasks, updateBot, jumpToTask } = useWorkspace();
  const canEditIdentity = useApi().capabilities.editBotIdentity;
  const readOnlyTitle = canEditIdentity
    ? undefined
    : "Editing name and instructions isn't supported by the backend yet";
  const [name, setName] = useState(bot.name);
  const [instructions, setInstructions] = useState(bot.instructions);
  const [memory, setMemory] = useState(bot.memory);
  const assigned = tasks.filter((t) => t.participantBotIds.includes(bot.id));

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) setName(bot.name);
    else if (trimmed !== bot.name) void updateBot(bot.id, { name: trimmed });
  };

  return (
    <aside className="inspector-column" aria-label="Bot settings">
      <div className="profile-hero">
        <BotAvatar bot={bot} size="lg" />
        <input
          type="text"
          className="profile-name-input"
          value={name}
          readOnly={!canEditIdentity}
          title={readOnlyTitle}
          aria-label="Bot name"
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <div className="profile-role">{bot.role}</div>
        <div className="swatch-row">
          {BOT_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={`color-swatch ${bot.color === color ? "active" : ""}`}
              style={{ background: color }}
              aria-label={`Colour ${color}`}
              aria-pressed={bot.color === color}
              onClick={() => void updateBot(bot.id, { color })}
            />
          ))}
        </div>
        <div className="glyph-picker">
          {BOT_GLYPHS.map((glyph) => (
            <button
              key={glyph}
              type="button"
              className={`glyph-btn ${bot.glyph === glyph ? "active" : ""}`}
              aria-pressed={bot.glyph === glyph}
              onClick={() => void updateBot(bot.id, { glyph })}
            >
              {glyph}
            </button>
          ))}
        </div>
      </div>

      <div className="inspector-section">
        <label className="field-label" htmlFor={`instructions-${bot.id}`}>
          Instructions
        </label>
        <textarea
          id={`instructions-${bot.id}`}
          className="field-textarea"
          value={instructions}
          readOnly={!canEditIdentity}
          title={readOnlyTitle}
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => {
            if (instructions !== bot.instructions)
              void updateBot(bot.id, { instructions });
          }}
        />
      </div>

      <div className="inspector-section">
        <label className="field-label" htmlFor={`memory-${bot.id}`}>
          Scoped memory
        </label>
        <textarea
          id={`memory-${bot.id}`}
          className="field-textarea"
          value={memory}
          placeholder="Nothing remembered yet."
          onChange={(event) => setMemory(event.target.value)}
          onBlur={() => {
            if (memory !== bot.memory) void updateBot(bot.id, { memory });
          }}
        />
      </div>

      <div className="inspector-section last">
        <div className="field-label">Tasks ({assigned.length})</div>
        <div className="mini-task-list">
          {assigned.map((task) => (
            <button
              key={task.id}
              type="button"
              className="mini-task-row"
              onClick={() => jumpToTask(task.id)}
            >
              <span className="mini-task-main">
                <StatusDot status={task.status} />
                <span className="mini-task-title">{task.goal}</span>
              </span>
              <span className="row-arrow">→</span>
            </button>
          ))}
          {assigned.length === 0 && (
            <p className="list-empty">Not in any tasks yet.</p>
          )}
        </div>
      </div>
    </aside>
  );
}
