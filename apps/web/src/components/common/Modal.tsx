import { type FormEvent, type ReactNode, useEffect } from "react";

export function Modal({
  title,
  submitLabel,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  submitLabel: string;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <div
      className="modal-backdrop open"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="modal-card"
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <h3 className="modal-title">{title}</h3>
        {children}
        <div className="modal-actions">
          <button type="button" className="action-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-btn">
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
