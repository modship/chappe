import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch } from "../lib/fuzzy";
import { isMac } from "../lib/platform";
import { serverAddress, type ServerEntry } from "../lib/servers";
import type { LocalProfile } from "../lib/local";

export type PaletteChoice =
  | { kind: "profile"; profile: LocalProfile }
  | { kind: "server"; server: ServerEntry }
  | { kind: "address"; spec: string };

interface Props {
  profiles: LocalProfile[];
  servers: ServerEntry[];
  /** Last use per item key, newest first in the list. */
  recent: Record<string, number>;
  onChoose(choice: PaletteChoice): void;
  onAddServer(): void;
  onEditServer(server: ServerEntry): void;
  onClose(): void;
}

interface Item {
  key: string;
  name: string;
  detail: string;
  choice: PaletteChoice | null;
  server?: ServerEntry;
  score: number;
  highlight: number[];
}

/** `[user@]host[:port]`, optionally typed as `ssh …`. */
const ADDRESS = /^(?:ssh\s+)?((?:[^\s@]+@)?(?:\[[0-9a-fA-F:]+\]|[A-Za-z0-9._-]+)(?::\d{1,5})?)$/;

export const choiceKey = (choice: PaletteChoice): string =>
  choice.kind === "profile"
    ? `local:${choice.profile.id}`
    : choice.kind === "server"
      ? `ssh:${choice.server.id}`
      : `ssh:${choice.spec}`;

const shortcutFor = (index: number) => (index < 9 ? (isMac ? `⌘${index + 1}` : `Alt+${index + 1}`) : null);

function Highlighted({ text, indexes }: { text: string; indexes: number[] }) {
  if (!indexes.length) return <>{text}</>;
  const marked = new Set(indexes);
  return (
    <>
      {Array.from(text).map((ch, i) =>
        marked.has(i) ? (
          <mark key={i}>{ch}</mark>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

export function SessionPalette(props: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const items = useMemo<Item[]>(() => {
    const base: Omit<Item, "score" | "highlight">[] = [
      ...props.profiles.map((profile) => ({
        key: `local:${profile.id}`,
        name: profile.name,
        detail: profile.detail ? `${profile.detail}, local` : "Local shell",
        choice: { kind: "profile", profile } as PaletteChoice,
      })),
      ...props.servers.map((server) => ({
        key: `ssh:${server.id}`,
        name: server.name,
        detail: `${serverAddress(server)}, ${server.source === "saved" ? "saved" : "~/.ssh/config"}`,
        choice: { kind: "server", server } as PaletteChoice,
        server,
      })),
    ];

    const q = query.trim();
    let list: Item[];
    if (!q) {
      // Recently used first, then shells, saved servers and config hosts.
      list = base
        .map((item, order) => ({ ...item, score: (props.recent[item.key] ?? 0) * 1000 - order, highlight: [] }))
        .sort((a, b) => b.score - a.score);
    } else {
      list = base
        .map((item) => {
          const byName = fuzzyMatch(q, item.name);
          const byDetail = fuzzyMatch(q, item.detail);
          if (!byName && !byDetail) return null;
          const score = Math.max((byName?.score ?? -Infinity) * 2, byDetail?.score ?? -Infinity);
          return { ...item, score: score + (props.recent[item.key] ? 5 : 0), highlight: byName?.indexes ?? [] };
        })
        .filter((item): item is Item => item !== null)
        .sort((a, b) => b.score - a.score);

      const address = ADDRESS.exec(q)?.[1];
      const looksLikeHost = address && /[@.:]/.test(address);
      const exact = list.some((item) => item.name.toLowerCase() === q.toLowerCase());
      if (address && looksLikeHost && !exact) {
        const item: Item = {
          key: `address:${address}`,
          name: `Connect to ${address}`,
          detail: "SSH",
          choice: { kind: "address", spec: address },
          score: 0,
          highlight: [],
        };
        if (address.includes("@") || list.length === 0) list.unshift(item);
        else list.push(item);
      }
    }

    list.push({ key: "action:add", name: "Add a server…", detail: "", choice: null, score: 0, highlight: [] });
    return list;
  }, [props.profiles, props.servers, props.recent, query]);

  const count = items.filter((item) => item.choice).length;

  useEffect(() => setSelected(0), [query]);

  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if (item.choice) props.onChoose(item.choice);
    else props.onAddServer();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const page = 8;
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit && (isMac ? e.metaKey : e.altKey)) {
      e.preventDefault();
      choose(items[Number(digit[1]) - 1]);
      return;
    }
    if ((isMac ? e.metaKey : e.ctrlKey) && e.code === "KeyE") {
      e.preventDefault();
      const server = items[selected]?.server;
      if (server) props.onEditServer(server);
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected((s) => Math.min(items.length - 1, s + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected((s) => Math.max(0, s - 1));
        break;
      case "PageDown":
        e.preventDefault();
        setSelected((s) => Math.min(items.length - 1, s + page));
        break;
      case "PageUp":
        e.preventDefault();
        setSelected((s) => Math.max(0, s - page));
        break;
      case "Enter":
        e.preventDefault();
        choose(items[selected]);
        break;
      case "Escape":
        e.preventDefault();
        props.onClose();
        break;
    }
  };

  return (
    <div className="palette-layer" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="palette" role="dialog" aria-label="New session" onKeyDown={onKeyDown}>
        <div className="palette-search">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M9.3 9.3L12.5 12.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            placeholder="Search sessions, or type user@host:port"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={`palette-item-${selected}`}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="palette-count" aria-label={`${count} sessions`}>
            {count}
          </span>
        </div>

        <ul ref={listRef} id="palette-list" className="palette-list" role="listbox">
          {items.map((item, index) => {
            const shortcut = item.choice ? shortcutFor(index) : null;
            return (
              <li
                key={item.key}
                id={`palette-item-${index}`}
                role="option"
                aria-selected={index === selected}
                className="palette-item"
                data-action={!item.choice}
                onMouseMove={() => index !== selected && setSelected(index)}
                onClick={() => choose(item)}
              >
                <span className="palette-name">
                  <Highlighted text={item.name} indexes={item.highlight} />
                </span>
                <span className="palette-detail">{item.detail}</span>
                {item.server && (
                  <button
                    type="button"
                    className="icon-button palette-edit"
                    aria-label={`Edit ${item.server.name}`}
                    title={item.server.source === "saved" ? "Edit" : "Save a copy to edit it"}
                    onClick={(e) => {
                      e.stopPropagation();
                      props.onEditServer(item.server!);
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M7.6 2.2l2.2 2.2M2 10l.6-2.6L8.4 1.6a.9.9 0 011.3 0l.7.7a.9.9 0 010 1.3L4.6 9.4z"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                )}
                {shortcut && <kbd className="palette-key">{shortcut}</kbd>}
              </li>
            );
          })}
        </ul>

        <div className="palette-help" aria-hidden="true">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>{isMac ? "⌘E" : "Ctrl+E"}</kbd> edit server
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
