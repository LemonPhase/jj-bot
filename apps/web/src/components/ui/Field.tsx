import {
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from "react";
import { cx } from "./cx";
import { Icon } from "./Icon";
import "./ui.css";

/** Label, help and error props shared by Input, Textarea and Select. */
interface FieldProps {
  /** Visible label (mono, uppercase via CSS). Always required for accessibility. */
  label: string;
  /** Keeps the label for assistive technology but hides it, e.g. inside a composer. */
  hideLabel?: boolean;
  /** Short mono note right of the label, like the Studio TOPPER note. */
  note?: ReactNode;
  /** Help text under the field. */
  hint?: ReactNode;
  /** Error text under the field; also sets `aria-invalid`. Shown as text, never colour alone. */
  error?: ReactNode;
  /** Class for the outer wrapper. */
  className?: string;
}

interface ShellProps extends FieldProps {
  id: string;
  hintId: string;
  errorId: string;
  children: ReactNode;
}

function FieldShell({
  id,
  hintId,
  errorId,
  label,
  hideLabel,
  note,
  hint,
  error,
  className,
  children,
}: ShellProps) {
  return (
    <div className={cx("ui-field", className)}>
      {hideLabel ? (
        <label htmlFor={id} className="visually-hidden">
          {label}
        </label>
      ) : (
        <div className="ui-field__head">
          <label htmlFor={id} className="ui-field__label">
            {label}
          </label>
          {note && <span className="ui-field__note">{note}</span>}
        </div>
      )}
      {children}
      {hint && (
        <p id={hintId} className="ui-field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="ui-field__error">
          {error}
        </p>
      )}
    </div>
  );
}

function useFieldIds(
  explicitId: string | undefined,
  props: FieldProps,
  callerDescribedBy: string | undefined,
) {
  const generated = useId();
  const id = explicitId ?? generated;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  // The caller's own descriptions come first, then the hint and the error.
  const describedBy =
    [callerDescribedBy, props.hint && hintId, props.error && errorId]
      .filter(Boolean)
      .join(" ") || undefined;
  return { id, hintId, errorId, describedBy };
}

const shellProps = (props: FieldProps) => ({
  label: props.label,
  hideLabel: props.hideLabel,
  note: props.note,
  hint: props.hint,
  error: props.error,
  className: props.className,
});

export interface InputProps
  extends FieldProps,
    Omit<InputHTMLAttributes<HTMLInputElement>, "className"> {}

/** Single-line text field. Extra props go to the <input>. */
export function Input({
  label,
  hideLabel,
  note,
  hint,
  error,
  className,
  id: explicitId,
  "aria-describedby": callerDescribedBy,
  ...rest
}: InputProps) {
  const field = { label, hideLabel, note, hint, error, className };
  const ids = useFieldIds(explicitId, field, callerDescribedBy);
  return (
    <FieldShell {...shellProps(field)} {...ids}>
      <input
        id={ids.id}
        className="ui-input"
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

export interface TextareaProps
  extends FieldProps,
    Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> {}

/** Multi-line text field, resizable vertically. Extra props go to the <textarea>. */
export function Textarea({
  label,
  hideLabel,
  note,
  hint,
  error,
  className,
  id: explicitId,
  "aria-describedby": callerDescribedBy,
  ...rest
}: TextareaProps) {
  const field = { label, hideLabel, note, hint, error, className };
  const ids = useFieldIds(explicitId, field, callerDescribedBy);
  return (
    <FieldShell {...shellProps(field)} {...ids}>
      <textarea
        id={ids.id}
        className="ui-textarea"
        aria-describedby={ids.describedBy}
        aria-invalid={error ? true : undefined}
        {...rest}
      />
    </FieldShell>
  );
}

export interface SelectOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<Value extends string>
  extends FieldProps,
    Omit<
      SelectHTMLAttributes<HTMLSelectElement>,
      "className" | "value" | "onChange" | "children"
    > {
  options: readonly SelectOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
}

/** Native select styled as a field, typed by its option values. */
export function Select<Value extends string>({
  label,
  hideLabel,
  note,
  hint,
  error,
  className,
  id: explicitId,
  "aria-describedby": callerDescribedBy,
  options,
  value,
  onChange,
  ...rest
}: SelectProps<Value>) {
  const field = { label, hideLabel, note, hint, error, className };
  const ids = useFieldIds(explicitId, field, callerDescribedBy);
  return (
    <FieldShell {...shellProps(field)} {...ids}>
      <span className="ui-select-wrap">
        <select
          id={ids.id}
          className="ui-select"
          aria-describedby={ids.describedBy}
          aria-invalid={error ? true : undefined}
          value={value}
          onChange={(event) => {
            const next = options.find(
              (option) => option.value === event.target.value,
            );
            if (next) onChange(next.value);
          }}
          {...rest}
        >
          {options.map((option) => (
            <option
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </option>
          ))}
        </select>
        <Icon
          name="chevron-down"
          size={14}
          className="ui-select-wrap__chevron"
        />
      </span>
    </FieldShell>
  );
}
