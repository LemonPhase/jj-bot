// The chat history a reply sends to the model, built from stored messages.
// A past reply with a task card names that task in a note, as the user sees
// the card under it; notes are never stored, and a reply that imitates one
// has it removed before it is stored. Entries alternate between the user and
// the bot and start with the user, as every provider accepts.
import type { ChatHistoryEntry } from "../ports";

/** The note that stands for a task card in the model's view of a past reply. */
export const cardNote = (taskId: string, title: string | undefined) =>
  `[Task card: ${taskId}${title === undefined ? "" : ` ${JSON.stringify(title)}`}]`;

const CARD_NOTE_LINE = /^[ \t]*\[Task card:[^\]\n]*\][ \t]*$/gm;

/** `text` without card notes (lines like `[Task card: task_… "Title"]`). */
export function stripCardNotes(text: string): string {
  return text
    .replace(CARD_NOTE_LINE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Stands in for the user before a history that starts with the bot. */
export const HISTORY_START = "(Earlier messages of this chat are not shown.)";

export interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  taskId: string | null;
}

/**
 * The model's history: each message's text (a reply with a card gets its
 * note), consecutive messages of one side joined, and a first entry from the
 * user.
 */
export function modelHistory(
  messages: readonly StoredMessage[],
  titles: ReadonlyMap<string, string>,
  redact: (text: string) => string,
): ChatHistoryEntry[] {
  const entries: ChatHistoryEntry[] = [];
  for (const message of messages) {
    let text = message.text;
    if (message.role === "assistant") {
      text = stripCardNotes(text) || text;
      if (message.taskId) {
        const title = titles.get(message.taskId);
        text = `${text}\n\n${cardNote(message.taskId, title === undefined ? undefined : redact(title))}`;
      }
    }
    const last = entries.at(-1);
    if (last && last.role === message.role)
      last.text = `${last.text}\n\n${text}`;
    else entries.push({ role: message.role, text });
  }
  if (entries[0]?.role === "assistant")
    entries.unshift({ role: "user", text: HISTORY_START });
  return entries;
}

/** Appends an entry, joined to the last one when it is from the same side. */
export function appendEntry(
  entries: ChatHistoryEntry[],
  entry: ChatHistoryEntry,
): ChatHistoryEntry[] {
  const last = entries.at(-1);
  if (last && last.role === entry.role)
    return [
      ...entries.slice(0, -1),
      { role: last.role, text: `${last.text}\n\n${entry.text}` },
    ];
  return [...entries, entry];
}
