/**
 * Pure pieces of the workspace's direct-chat state: the user message a send
 * stored, shown at once and kept until a fetched conversation includes it.
 */
import type { ConversationMessage, ConversationView } from "@jj/contracts";

const bySequence = (a: ConversationMessage, b: ConversationMessage) =>
  a.sequence - b.sequence;

const emptyConversation = (botId: string): ConversationView => ({
  botId,
  messages: [],
  replying: false,
  lastReplyError: null,
});

/**
 * The conversation with a just-stored user message in it (deduplicated by
 * id) and the bot replying, as the server has it once the send returns.
 */
export function withStoredMessage(
  view: ConversationView | undefined,
  message: ConversationMessage,
): ConversationView {
  const base = view ?? emptyConversation(message.botId);
  const messages = [
    ...base.messages.filter((existing) => existing.id !== message.id),
    message,
  ].sort(bySequence);
  return { ...base, messages, replying: true };
}

/**
 * A fetched conversation with the stored messages it does not include yet
 * (it was read before the send landed), and those still missing from it.
 */
export function withUnseenMessages(
  view: ConversationView,
  stored: readonly ConversationMessage[],
): { view: ConversationView; unseen: ConversationMessage[] } {
  const known = new Set(view.messages.map((message) => message.id));
  const unseen = stored.filter((message) => !known.has(message.id));
  if (unseen.length === 0) return { view, unseen };
  const merged = unseen.reduce<ConversationView>(
    (current, message) => withStoredMessage(current, message),
    view,
  );
  return { view: merged, unseen };
}

/** Task ids the messages link to that the task list does not have yet. */
export function unknownTaskIds(
  view: ConversationView,
  known: ReadonlySet<string>,
): string[] {
  const ids = new Set<string>();
  for (const message of view.messages)
    if (message.taskId && !known.has(message.taskId)) ids.add(message.taskId);
  return [...ids];
}
