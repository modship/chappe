import { useEffect, useRef, useState } from "react";
import { installUpdate, updateError, type Progress, type Update } from "../lib/updates";

interface Props {
  update: Update;
  /** Editors with unsaved changes: they must be saved before restarting. */
  unsaved: number;
  onClose(): void;
}

function megabytes(bytes: number) {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function releaseDate(date?: string): string | null {
  if (!date) return null;
  const parsed = new Date(date.replace(" ", "T").replace(/ (?=[+-])/, ""));
  return Number.isNaN(parsed.getTime())
    ? null
    : parsed.toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric" });
}

/** What's new, then download, install and restart. */
export function UpdateDialog({ update, unsaved, onClose }: Props) {
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const installing = progress !== null && !error;
  const installRef = useRef<HTMLButtonElement>(null);
  useEffect(() => installRef.current?.focus(), []);

  const install = () => {
    setError(null);
    setProgress({ downloaded: 0, total: null });
    installUpdate(update, setProgress).catch((e) => setError(updateError(e)));
  };

  const done = progress && progress.total ? Math.min(1, progress.downloaded / progress.total) : null;
  const date = releaseDate(update.date);

  return (
    <div className="modal-layer" onMouseDown={(e) => e.target === e.currentTarget && !installing && onClose()}>
      <div
        className="modal update-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-title"
        onKeyDown={(e) => e.key === "Escape" && !installing && onClose()}
      >
        <h2 id="update-title">Chappe {update.version} is available</h2>
        <p className="modal-body">
          You have version {update.currentVersion}.{date ? ` Released ${date}.` : ""}
        </p>
        {update.body?.trim() && <div className="update-notes">{update.body.trim()}</div>}

        {installing ? (
          <div className="update-progress" role="status">
            <div className="update-bar">
              <span style={{ width: done === null ? "100%" : `${done * 100}%` }} data-indeterminate={done === null} />
            </div>
            <span>
              {done === 1
                ? "Installing, Chappe will restart…"
                : progress.total
                  ? `Downloading ${megabytes(progress.downloaded)} of ${megabytes(progress.total)}`
                  : `Downloading ${megabytes(progress.downloaded)}`}
            </span>
          </div>
        ) : (
          <>
            {error && <p className="form-error">{error}</p>}
            {unsaved > 0 && (
              <p className="form-error">
                {unsaved === 1 ? "A file has" : `${unsaved} files have`} unsaved changes. Save {unsaved === 1 ? "it" : "them"}{" "}
                first: Chappe restarts to finish the update.
              </p>
            )}
            {!unsaved && <p className="update-hint">Open sessions will be closed when Chappe restarts.</p>}
          </>
        )}

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button type="button" className="button-quiet" onClick={onClose} disabled={installing}>
            Later
          </button>
          <button
            ref={installRef}
            type="button"
            className="button-primary"
            onClick={install}
            disabled={installing || unsaved > 0}
          >
            {error ? "Try again" : "Install and restart"}
          </button>
        </div>
      </div>
    </div>
  );
}
