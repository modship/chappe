import { useEffect, useMemo, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { oneLine, shortPath, timeAgo, type SessionCommand, type TabHistory } from "../lib/history";
import { isMac } from "../lib/platform";
import { shortcutLabel } from "../lib/shortcuts";

interface Props {
  /** The active terminal's name, or null when the active tab isn't a terminal. */
  label: string | null;
  history: TabHistory | null;
  /** Why commands can't go to the active tab, if they can't. */
  unavailable: string | null;
  onInsert(command: string): void;
  /** Returns why the command didn't run, if it didn't. */
  onRun(command: string): string | null;
  onRemove(command: string): void;
  /** Reads older commands from the shell's history file. */
  onLoadMore(): Promise<void>;
  onClear(): void;
  onClose(): void;
}

type Row = ({ kind: "session" } & SessionCommand) | { kind: "earlier"; command: string };

const rowKey = (row: Row) => `${row.kind}:${row.command}`;

/** Rows drawn at most; the filter narrows the rest down. */
const SHOWN = 1500;

const modEnter = isMac ? "⌘↵" : "Ctrl+↵";

export function HistoryPanel({
  label,
  history,
  unavailable,
  onInsert,
  onRun,
  onRemove,
  onLoadMore,
  onClear,
  onClose,
}: Props) {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  // Keeps "5 min ago" true.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // Another tab, another list.
  useEffect(() => {
    setNotice(null);
    setSelected(null);
  }, [label]);

  const session = history?.session ?? [];
  const earlier = history?.earlier ?? [];

  const rows = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = (command: string) => {
      const text = command.toLowerCase();
      return words.every((word) => text.includes(word));
    };
    const ran = new Set(session.map((c) => c.command));
    return [
      ...session.filter((c) => matches(c.command)).map((c): Row => ({ kind: "session", ...c })),
      ...earlier.filter((c) => !ran.has(c) && matches(c)).map((command): Row => ({ kind: "earlier", command })),
    ];
  }, [session, earlier, filter]);
  const shown = rows.slice(0, SHOWN);
  const current = shown.find((r) => rowKey(r) === selected) ?? null;
  const firstEarlier = shown.findIndex((r) => r.kind === "earlier");
  const canLoadMore = Boolean(history?.more) && rows.length <= SHOWN;

  const loadMore = () => {
    setLoading(true);
    onLoadMore().finally(() => setLoading(false));
  };

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  // ⌘C goes through the native Edit menu as a "copy" event.
  const latest = useRef(current);
  latest.current = current;
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const row = latest.current;
      if (!row || !listRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", row.command);
    };
    document.addEventListener("copy", onCopy);
    return () => document.removeEventListener("copy", onCopy);
  }, []);

  const insert = (row: Row) => {
    if (unavailable) return setNotice(unavailable);
    setNotice(null);
    onInsert(row.command);
  };

  const run = (row: Row) => {
    if (unavailable) return setNotice(unavailable);
    setNotice(onRun(row.command));
  };

  const remove = (row: Row) => {
    const index = shown.indexOf(row);
    const next = shown[index + 1] ?? shown[index - 1] ?? null;
    setSelected(next ? rowKey(next) : null);
    onRemove(row.command);
  };

  const copy = (row: Row) => void writeText(row.command);

  const itemMenu = (row: Row): MenuItem[] => [
    { label: "Insert in terminal", onSelect: () => insert(row), hint: "↵", disabled: Boolean(unavailable) },
    { label: "Run", onSelect: () => run(row), hint: modEnter, disabled: Boolean(unavailable) },
    "separator",
    { label: "Copy", onSelect: () => copy(row), hint: isMac ? "⌘C" : "Ctrl+C" },
    "separator",
    { label: "Remove from list", danger: true, onSelect: () => remove(row), hint: isMac ? "⌘⌫" : "Del" },
  ];

  const move = (step: number | "first" | "last") => {
    if (!shown.length) return;
    const index = current ? shown.indexOf(current) : -1;
    let next: number;
    if (step === "first") next = 0;
    else if (step === "last") next = shown.length - 1;
    else if (index === -1) next = 0;
    else next = Math.max(0, Math.min(shown.length - 1, index + step));
    setSelected(rowKey(shown[next]));
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        return move(1);
      case "ArrowUp":
        e.preventDefault();
        if (current && shown.indexOf(current) === 0) {
          return document.querySelector<HTMLInputElement>(".history-filter")?.focus();
        }
        return move(-1);
      case "Home":
        e.preventDefault();
        return move("first");
      case "End":
        e.preventDefault();
        return move("last");
      case "PageDown":
        e.preventDefault();
        return move(10);
      case "PageUp":
        e.preventDefault();
        return move(-10);
      case "Enter":
        if (!current) return;
        e.preventDefault();
        return mod ? run(current) : insert(current);
      case "Delete":
      case "Backspace":
        if (!current || (e.key === "Backspace" && !(isMac && e.metaKey))) return;
        e.preventDefault();
        return remove(current);
      case "Escape":
        if (filter) {
          e.preventDefault();
          setFilter("");
        }
        return;
    }
    if (!isMac && e.ctrlKey && e.code === "KeyC" && current) {
      e.preventDefault();
      copy(current);
    }
  };

  const total = session.length + earlier.filter((c) => !session.some((s) => s.command === c)).length;

  let empty: string | null = null;
  if (!label) empty = "Switch to a terminal tab to see its commands.";
  else if (!total) empty = "Commands you run in this terminal show up here.";
  else if (!rows.length) empty = `No command matches “${filter.trim()}”.`;

  const status = () => {
    if (!label || !total) return "";
    if (rows.length > SHOWN) return `${SHOWN} of ${rows.length} commands. Filter to find the others.`;
    if (filter.trim()) return `${rows.length} of ${total} commands`;
    const parts = [`${session.length} this session`];
    if (total > session.length) parts.push(`${total - session.length} earlier`);
    return parts.join(" · ");
  };

  return (
    <aside className="history" aria-label="Command history">
      <div className="files-titlebar history-titlebar" data-tauri-drag-region>
        <h2 className="files-title" data-tauri-drag-region>
          History
          {label && <span className="files-where"> of {label}</span>}
        </h2>
        <span className="files-actions">
          <button
            type="button"
            className="icon-button"
            aria-label="Clear this list"
            title="Clear this list…"
            disabled={!total}
            onClick={() => setConfirmClear(true)}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M2.2 3.6h9.6M5.4 3.6V2.2h3.2v1.4M3.5 3.6l.6 8.2h5.8l.6-8.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Hide history"
            title={`Hide history (${shortcutLabel.toggleHistory})`}
            onClick={onClose}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </button>
        </span>
      </div>

      <input
        className="files-input files-filter history-filter"
        type="search"
        placeholder="Filter commands"
        aria-label="Filter commands"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={!label}
        value={filter}
        onChange={(e) => {
          setFilter(e.target.value);
          setSelected(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "Enter") {
            e.preventDefault();
            if (shown.length) {
              setSelected(rowKey(current ?? shown[0]));
              listRef.current?.focus();
            }
          } else if (e.key === "Escape" && filter) {
            e.preventDefault();
            setFilter("");
          }
        }}
      />

      <ul
        ref={listRef}
        className="history-list"
        role="listbox"
        aria-label="Commands"
        tabIndex={0}
        onKeyDown={onListKey}
        onFocus={(e) => {
          // Not when the focus lands on the "Load more" button.
          if (e.target === e.currentTarget && !current && shown.length) setSelected(rowKey(shown[0]));
        }}
      >
        {shown.map((row, index) => {
          const key = rowKey(row);
          return [
            index === firstEarlier && (
              <li key="earlier" className="history-section" role="presentation">
                Before this session
              </li>
            ),
            <li
              key={key}
              className="history-row"
              role="option"
              aria-selected={key === selected}
              data-kind={row.kind}
              onMouseDown={() => setSelected(key)}
              onDoubleClick={() => run(row)}
              onContextMenu={(e) => {
                e.preventDefault();
                setSelected(key);
                setMenu({ x: e.clientX, y: e.clientY, items: itemMenu(row) });
              }}
            >
              <span className="history-command">{oneLine(row.command)}</span>
              {row.kind === "session" && (
                <span className="history-meta">
                  {row.cwd && <span className="history-cwd">{shortPath(row.cwd)}</span>}
                  <span className="history-when">{timeAgo(row.at, now)}</span>
                  {row.count > 1 && <span className="history-count">×{row.count}</span>}
                </span>
              )}
              <span className="history-actions">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Insert in terminal"
                  title="Insert in terminal (↵)"
                  tabIndex={-1}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={() => insert(row)}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <path
                      d="M10 2.5v3.2a1.6 1.6 0 01-1.6 1.6H2.5M4.8 5L2.5 7.3l2.3 2.3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                <button
                  type="button"
                  className="icon-button history-run"
                  aria-label="Run"
                  title={`Run (${modEnter})`}
                  tabIndex={-1}
                  onMouseDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onClick={() => run(row)}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                    <path d="M3.2 2.2l6.4 3.8-6.4 3.8z" fill="currentColor" />
                  </svg>
                </button>
              </span>
            </li>,
          ];
        })}
        {canLoadMore && (
          <>
            {firstEarlier === -1 && (
              <li className="history-section" role="presentation">
                Before this session
              </li>
            )}
            <li className="history-more" role="presentation">
              <button type="button" className="button-quiet button-small" disabled={loading} onClick={loadMore}>
                {loading ? "Loading…" : "Load more"}
              </button>
            </li>
          </>
        )}
        {empty && !canLoadMore && <li className="files-empty history-empty">{empty}</li>}
      </ul>

      <footer className="files-status" data-notice={notice ? "true" : undefined}>
        <span className="files-status-text" role="status">
          {notice ?? status()}
        </span>
        {notice && (
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        )}
      </footer>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => {
            setMenu(null);
            listRef.current?.focus();
          }}
        />
      )}
      {confirmClear && (
        <ConfirmDialog
          title={`Clear the history of ${label}?`}
          body="The commands listed here will be removed from this panel. Your shell's own history isn't touched."
          confirm="Clear"
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            setSelected(null);
            onClear();
          }}
        />
      )}
    </aside>
  );
}
