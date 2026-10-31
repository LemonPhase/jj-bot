import { type FormEvent, type ReactNode, useState } from "react";

export function Composer({
  placeholder,
  onSend,
  leading,
  disabled = false,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  /** Optional control rendered before the input (e.g. the Steer chip). */
  leading?: ReactNode;
  /** Locks the composer while a turn is in flight. */
  disabled?: boolean;
}) {
  const [text, setText] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    onSend(trimmed);
  };

  return (
    <div className="composer-wrap">
      <form className="composer-bar" onSubmit={submit} aria-busy={disabled}>
        {leading}
        <input
          type="text"
          className="composer-input"
          placeholder={placeholder}
          aria-label={placeholder}
          autoComplete="off"
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          type="submit"
          className="send-btn"
          aria-label="Send"
          disabled={disabled}
        >
          ↑
        </button>
      </form>
    </div>
  );
}
