import type { Bot } from "@jj/contracts";
import { useId, useState } from "react";
import { type CommandOutcome, createBot } from "./commands";

export function NewBotForm({ onDraft }: { onDraft: (bot: Bot) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [outcome, setOutcome] = useState<CommandOutcome | null>(null);
  const [sending, setSending] = useState(false);
  const nameId = useId();
  const instructionsId = useId();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (sending) return;
    setSending(true);
    const command = { name: name.trim(), instructions: instructions.trim() };
    const result = await createBot(command);
    setOutcome(result);
    if (result.status === "rejected") {
      // The API refused it, so the bot exists only in this browser tab. Shown, but
      // never presented as a persisted bot.
      onDraft({ id: `draft-${crypto.randomUUID()}`, ...command });
    }
    setName("");
    setInstructions("");
    setSending(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        className="add-button"
        onClick={() => setOpen(true)}
      >
        + Add a bot
      </button>
    );
  }

  return (
    <form className="create-form" onSubmit={submit}>
      <div className="panel-heading">
        <h3>New bot</h3>
        <button
          type="button"
          className="link-button"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
      <label className="tiny-label" htmlFor={nameId}>
        Name
      </label>
      <input
        id={nameId}
        value={name}
        placeholder="Ember"
        onChange={(event) => setName(event.target.value)}
      />
      <label className="tiny-label" htmlFor={instructionsId}>
        Instructions
      </label>
      <textarea
        id={instructionsId}
        value={instructions}
        rows={2}
        placeholder="What this bot is for, and how it should behave."
        onChange={(event) => setInstructions(event.target.value)}
      />
      <div className="composer-actions">
        <button
          type="submit"
          disabled={sending || !name.trim() || !instructions.trim()}
        >
          {sending ? "Creating…" : "Create bot ↗"}
        </button>
        {outcome?.status === "rejected" ? (
          <span className="command-error" role="alert">
            {outcome.reason} Kept in this tab only.
          </span>
        ) : null}
        {outcome?.status === "accepted" ? (
          <span className="command-ok" role="status">
            Created by the API.
          </span>
        ) : null}
      </div>
    </form>
  );
}
