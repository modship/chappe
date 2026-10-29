import type { Tab } from "../App";
import { shellName } from "../lib/title";
import { shortcutLabel } from "../lib/shortcuts";
import { GearIcon } from "./GearIcon";

const stateText: Record<Tab["state"], string> = {
  connecting: "Connecting",
  live: "Connected",
  ended: "Disconnected",
};

interface Props {
  tab: Tab | null;
  filesVisible: boolean;
  onToggleFiles(): void;
  historyVisible: boolean;
  onToggleHistory(): void;
  onOpenSettings(): void;
  configError: string | null;
}

export function StatusBar({ tab, filesVisible, onToggleFiles, historyVisible, onToggleHistory, onOpenSettings, configError }: Props) {
  const remote = tab?.target.kind === "ssh";
  return (
    <footer className="statusbar">
      <button
        type="button"
        className="icon-button"
        aria-pressed={filesVisible}
        aria-label={filesVisible ? "Hide files" : "Show files"}
        title={`${filesVisible ? "Hide" : "Show"} files (${shortcutLabel.toggleFiles})`}
        onClick={onToggleFiles}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <rect x="1.2" y="2" width="11.6" height="10" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 2v10" stroke="currentColor" strokeWidth="1.2" />
          {filesVisible && <path d="M1.8 2.6h3.2v8.8H1.8z" fill="currentColor" opacity="0.5" />}
        </svg>
      </button>
      {tab?.target.kind === "editor" ? (
        <>
          <span className="status-item" data-state={tab.dirty ? "connecting" : "live"}>
            <span className="status-dot" aria-hidden="true" />
            {tab.dirty ? "Modified" : "Saved"}
          </span>
          <span className="status-item status-path" title={tab.target.file.path}>
            {tab.target.file.origin.kind === "ssh" ? `${tab.target.file.origin.serverName}:` : ""}
            {tab.target.file.path}
          </span>
        </>
      ) : tab?.target.kind === "settings" ? null : tab && (
        <>
          <span className="status-item" data-state={tab.state}>
            <span className="status-dot" aria-hidden="true" />
            {remote ? stateText[tab.state] : tab.state === "ended" ? "Exited" : "Local"}
          </span>
          <span className="status-item">{remote ? (tab.address ?? "") : shellName(tab.shell)}</span>
        </>
      )}
      {configError && (
        <span className="status-item status-warning" title={configError}>
          ~/.ssh/config has an error
        </span>
      )}
      <span className="status-spacer" />
      {tab?.target.kind === "editor" && (
        <>
          {tab.cursor && (
            <span className="status-item status-mono">
              Ln {tab.cursor.line}, Col {tab.cursor.col}
            </span>
          )}
          {tab.language && <span className="status-item">{tab.language}</span>}
          {tab.eol && <span className="status-item">{tab.eol}</span>}
          <span className="status-item">UTF-8</span>
        </>
      )}
      {tab?.target.kind !== "editor" && tab?.cols && tab.rows ? (
        <span className="status-item status-mono" title="Columns × rows">
          {tab.cols} × {tab.rows}
        </span>
      ) : null}
      <button
        type="button"
        className="icon-button"
        aria-label="Settings"
        title={`Settings (${shortcutLabel.settings})`}
        onClick={onOpenSettings}
      >
        <GearIcon />
      </button>
      <button
        type="button"
        className="icon-button"
        aria-pressed={historyVisible}
        aria-label={historyVisible ? "Hide history" : "Show history"}
        title={`${historyVisible ? "Hide" : "Show"} history (${shortcutLabel.toggleHistory})`}
        onClick={onToggleHistory}
      >
        <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
          <rect x="1.2" y="2" width="11.6" height="10" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M9 2v10" stroke="currentColor" strokeWidth="1.2" />
          {historyVisible && <path d="M9 2.6h3.2v8.8H9z" fill="currentColor" opacity="0.5" />}
        </svg>
      </button>
    </footer>
  );
}
