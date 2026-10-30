import { Logo } from "./Logo";
import { shortcutLabel } from "../lib/shortcuts";

export function EmptyState({ onNew }: { onNew(): void }) {
  return (
    <div className="empty">
      <Logo size={56} />
      <p className="empty-title">No open sessions</p>
      <button type="button" className="button-primary" onClick={onNew}>
        New session
      </button>
      <kbd className="empty-hint">{shortcutLabel.newSession}</kbd>
    </div>
  );
}
