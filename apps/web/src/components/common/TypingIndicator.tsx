import type { ReactNode } from "react";

/** A quiet "the agent is working" row shown while a turn is in flight. */
export function TypingIndicator({
  label,
  avatar,
}: {
  label: string;
  avatar?: ReactNode;
}) {
  return (
    <div className="msg-row bot typing-row" role="status" aria-live="polite">
      {avatar}
      <div className="msg-content-wrap">
        <div className="typing-bubble">
          <span className="typing-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>{label}</span>
        </div>
      </div>
    </div>
  );
}
