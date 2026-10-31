import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { cx } from "./cx";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import "./ui.css";

export interface ComposerProps {
  /** Accessible name of the field, visually hidden ("Message Juno"). */
  label: string;
  /** "Message Juno…" (Bots) or "Message task group…" (Tasks). */
  placeholder?: string;
  /**
   * Called with the trimmed text; the field clears at once. Return or resolve
   * `false`, or reject, to put the text back (when the send failed).
   */
  onSubmit: (text: string) => void | boolean | Promise<unknown>;
  /** A send is in flight: typing stays possible, sending waits. */
  sending?: boolean;
  /** The conversation takes no messages (e.g. a stopped task). Say why in `placeholder`. */
  disabled?: boolean;
  /** Controls before the field, like the Tasks steer toggle. */
  leading?: ReactNode;
  /** `bot`: max 680px, padding 10/10/10/18 (Bots). `task`: max 640px, padding 8 (Tasks). */
  variant?: "bot" | "task";
  /** The field grows with its text up to this many lines, then scrolls. Default 8. */
  maxRows?: number;
  /** The textarea, e.g. to focus it after switching conversation. */
  textareaRef?: Ref<HTMLTextAreaElement>;
  autoFocus?: boolean;
  /** Accessible name of the send button. Default "Send". */
  sendLabel?: string;
  className?: string;
}

const LINE_HEIGHT = 21; // 14px × 1.5

/**
 * The message composer (SPEC §4): a rounded surface box with a growing
 * textarea and a round send button. Enter sends, Shift+Enter adds a line, and
 * IME composition never sends. Mount it with `key={conversationId}` so the
 * draft resets per conversation.
 *
 * @example
 * <Composer key={bot.id} label={`Message ${bot.name}`} placeholder={`Message ${bot.name}…`}
 *   sending={Boolean(pending)} onSubmit={(text) => sendBotMessage(bot.id, text)} />
 */
export function Composer({
  label,
  placeholder,
  onSubmit,
  sending = false,
  disabled = false,
  leading,
  variant = "bot",
  maxRows = 8,
  textareaRef,
  autoFocus,
  sendLabel = "Send",
  className,
}: ComposerProps) {
  const id = useId();
  const [text, setText] = useState("");
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const canSend = !disabled && !sending && text.trim().length > 0;

  // Grow with the text, up to maxRows lines.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    const padding =
      Number.parseFloat(getComputedStyle(field).paddingTop) +
      Number.parseFloat(getComputedStyle(field).paddingBottom);
    const max = maxRows * LINE_HEIGHT + padding;
    field.style.height = `${Math.min(field.scrollHeight, max)}px`;
    field.style.overflowY = field.scrollHeight > max ? "auto" : "hidden";
  }, [text, maxRows]);

  const submit = () => {
    if (!canSend) return;
    const trimmed = text.trim();
    setText("");
    const restore = () => setText((current) => current || trimmed);
    try {
      const result = onSubmit(trimmed);
      if (result === false) restore();
      else if (result instanceof Promise)
        result.then((ok) => ok === false && restore(), restore);
    } catch {
      restore();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  const setRefs = (element: HTMLTextAreaElement | null) => {
    fieldRef.current = element;
    if (typeof textareaRef === "function") textareaRef(element);
    else if (textareaRef) textareaRef.current = element;
  };

  return (
    <form
      className={cx("ui-composer", `ui-composer--${variant}`, className)}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        submit();
      }}
      aria-busy={sending || undefined}
    >
      <div className="ui-composer__box" data-disabled={disabled || undefined}>
        {leading}
        <label htmlFor={id} className="visually-hidden">
          {label}
        </label>
        <textarea
          ref={setRefs}
          id={id}
          className="ui-composer__field"
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          autoComplete="off"
          autoFocus={autoFocus}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <IconButton
          type="submit"
          label={sendLabel}
          variant="primary"
          size="lg"
          icon={<Icon name="send" size={16} />}
          disabled={!canSend}
        />
      </div>
    </form>
  );
}
