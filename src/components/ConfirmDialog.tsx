import { useEffect, useRef } from "react";

interface Props {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  /** A third choice, shown on the left (e.g. "Don't save"). */
  alternative?: { label: string; onSelect(): void };
  onConfirm(): void;
  onCancel(): void;
}

export function ConfirmDialog({ title, body, confirm, danger, alternative, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => confirmRef.current?.focus(), []);
  return (
    <div className="modal-layer" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal modal-small"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-body" className="modal-body">
          {body}
        </p>
        <div className="modal-actions">
          {alternative && (
            <button type="button" className="button-danger" onClick={alternative.onSelect}>
              {alternative.label}
            </button>
          )}
          <span className="modal-spacer" />
          <button type="button" className="button-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={danger ? "button-danger-solid" : "button-primary"}
            onClick={onConfirm}
          >
            {confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
