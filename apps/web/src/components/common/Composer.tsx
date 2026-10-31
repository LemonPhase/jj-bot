import { type FormEvent, type ReactNode, useState } from "react";

export function Composer({
  placeholder,
  onSend,
  leading,
}: {
  placeholder: string;
  onSend: (text: string) => void;
  /** Optional control rendered before the input (e.g. the Steer chip). */
  leading?: ReactNode;
}) {
  const [text, setText] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    setText("");
    onSend(trimmed);
  };

  return (
    <div className="composer-wrap">
      <form className="composer-bar" onSubmit={submit}>
        {leading}
        <input
          type="text"
          className="composer-input"
          placeholder={placeholder}
          aria-label={placeholder}
          autoComplete="off"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="send-btn" aria-label="Send">
          ↑
        </button>
      </form>
    </div>
  );
}
