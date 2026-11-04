/** "3 Nov 2026": a day, with its year. */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "14:20" today, "Yesterday", or a short date. */
export function formatMessageTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (date >= startOfToday) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (date >= startOfYesterday) return "Yesterday";
  return date.toLocaleDateString([], { day: "numeric", month: "short" });
}
