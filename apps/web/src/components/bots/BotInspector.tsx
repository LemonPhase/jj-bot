import { BOT_COLOURS, BOT_FACES, type Bot } from "@jj/contracts";
import { useEffect, useState } from "react";
import { colourRamp } from "../../lib/colour";
import { statusWord } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { BotAvatar } from "../common/BotAvatar";
import { StatusDot } from "../common/StatusDot";

/** Bot settings. Mount with `key={bot.id}` so drafts reset per bot. */
export function BotInspector({ bot }: { bot: Bot }) {
  const { tasks, updateBot, jumpToTask, memories, loadMemory, saveMemory } =
    useWorkspace();
  const [name, setName] = useState(bot.name);
  const [instructions, setInstructions] = useState(bot.instructions);
  const stored = memories[bot.id];
  const [memory, setMemory] = useState<string | null>(stored?.text ?? null);
  const assigned = tasks.filter((t) => t.participantBotIds.includes(bot.id));

  // Once per bot: `loadMemory` is recreated on every workspace change.
  useEffect(() => {
    void loadMemory(bot.id);
  }, [bot.id]);
  useEffect(() => {
    if (stored && memory === null) setMemory(stored.text);
  }, [stored, memory]);

  const commitName = () => {
    const trimmed = name.trim();
    if (!trimmed) setName(bot.name);
    else if (trimmed !== bot.name) void updateBot(bot.id, { name: trimmed });
  };
  const setAppearance = (patch: Partial<Bot["appearance"]>) =>
    void updateBot(bot.id, { appearance: { ...bot.appearance, ...patch } });

  return (
    <aside className="inspector-column" aria-label="Bot settings">
      <div className="profile-hero">
        <BotAvatar bot={bot} size="lg" />
        <input
          type="text"
          className="profile-name-input"
          value={name}
          aria-label="Bot name"
          onChange={(event) => setName(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <div className="profile-role">{bot.role}</div>
        <div className="swatch-row">
          {BOT_COLOURS.map((colour) => (
            <button
              key={colour}
              type="button"
              className={`color-swatch ${bot.appearance.colour === colour ? "active" : ""}`}
              style={{ background: colourRamp(colour).f }}
              aria-label={`Colour ${colour}`}
              aria-pressed={bot.appearance.colour === colour}
              onClick={() => setAppearance({ colour })}
            />
          ))}
        </div>
        <div className="glyph-picker">
          {BOT_FACES.map((face) => (
            <button
              key={face}
              type="button"
              className={`glyph-btn ${bot.appearance.face === face ? "active" : ""}`}
              aria-pressed={bot.appearance.face === face}
              onClick={() => setAppearance({ face })}
            >
              {face}
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
          onChange={(event) => setInstructions(event.target.value)}
          onBlur={() => {
            if (instructions !== bot.instructions)
              void updateBot(bot.id, { instructions });
          }}
        />
      </div>

      <div className="inspector-section">
        <label className="field-label" htmlFor={`memory-${bot.id}`}>
          Memory
        </label>
        <textarea
          id={`memory-${bot.id}`}
          className="field-textarea"
          value={memory ?? ""}
          disabled={memory === null}
          placeholder={memory === null ? "Loading…" : "Nothing remembered yet."}
          onChange={(event) => setMemory(event.target.value)}
          onBlur={() => {
            if (memory !== null && memory !== (stored?.text ?? ""))
              void saveMemory(bot.id, memory);
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
                <span className="mini-task-title">{task.title}</span>
                <span className="mono-muted">{statusWord(task)}</span>
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
