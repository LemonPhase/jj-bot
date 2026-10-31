export function StatusDot({
  status,
  color,
}: {
  status?: string;
  /** Override with a bot colour instead of a status colour. */
  color?: string;
}) {
  return (
    <span
      className={`status-dot ${status ?? ""}`}
      style={color ? { background: color } : undefined}
      aria-hidden="true"
    />
  );
}
