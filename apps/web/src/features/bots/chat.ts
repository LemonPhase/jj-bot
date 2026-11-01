import type { ConversationMessage } from "@jj/contracts";

/** Messages sent on one local calendar day, under its divider label. */
export interface DayGroup {
  /** Stable key: the local date, "2026-10-31". */
  key: string;
  /** "Today", "Yesterday", or a short date such as "Mon 27 Oct". */
  label: string;
  messages: ConversationMessage[];
}

const pad = (value: number) => String(value).padStart(2, "0");

const localDayKey = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** The day-divider label for a timestamp, relative to `now` in local time. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const key = localDayKey(date);
  if (key === localDayKey(now)) return "Today";
  if (key === localDayKey(yesterday)) return "Yesterday";
  const part = (options: Intl.DateTimeFormatOptions) =>
    date.toLocaleDateString("en-GB", options);
  const label = `${part({ weekday: "short" })} ${date.getDate()} ${part({ month: "short" })}`;
  return date.getFullYear() === now.getFullYear()
    ? label
    : `${label} ${date.getFullYear()}`;
}

/** Splits a conversation into day groups, keeping message order. */
export function groupByDay(
  messages: readonly ConversationMessage[],
  now: Date = new Date(),
): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const message of messages) {
    const date = new Date(message.createdAt);
    const key = Number.isNaN(date.getTime()) ? "unknown" : localDayKey(date);
    const last = groups.at(-1);
    if (last && last.key === key) last.messages.push(message);
    else
      groups.push({
        key,
        label: dayLabel(message.createdAt, now),
        messages: [message],
      });
  }
  return groups;
}
