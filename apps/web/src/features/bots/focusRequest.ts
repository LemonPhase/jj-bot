/**
 * A one-shot request for the next Bots screen to take focus, so an action
 * that removes the current bot (archive) does not drop focus on <body>.
 */
const EMPTY = "\u0000empty";
let requested: string | null = null;

/** The next screen for this bot (null: the empty Bots screen) focuses its heading. */
export function requestBotFocus(botId: string | null): void {
  requested = botId ?? EMPTY;
}

/** True once for the screen the request is for; the request is then spent. */
export function takeBotFocus(botId: string | null): boolean {
  if (requested !== (botId ?? EMPTY)) return false;
  requested = null;
  return true;
}
