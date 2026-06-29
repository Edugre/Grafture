import { useEffect, useRef, type ReactNode } from "react";

import "./ConfirmDialog.css";

/**
 * A small modal that asks the user to confirm a consequential action before it runs. Closes on the
 * scrim, Cancel, or Esc; the confirm button gets initial focus reversed onto Cancel so a stray
 * Enter doesn't fire a destructive action. Pass `danger` for delete-style actions.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus Cancel, not Confirm, so an accidental Enter is a no-op rather than a deletion.
    cancelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onCancel]);

  return (
    <div
      className="confirm-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        className="confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
      >
        <h2 className="confirm-title" id="confirm-title">
          {title}
        </h2>
        <div className="confirm-message">{message}</div>
        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-btn confirm-btn--ghost"
            onClick={onCancel}
            ref={cancelRef}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`confirm-btn ${danger ? "confirm-btn--danger" : "confirm-btn--primary"}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
