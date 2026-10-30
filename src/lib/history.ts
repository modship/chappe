import { invoke } from "@tauri-apps/api/core";

/**
 * Command history is kept in memory, per terminal tab, and never written
 * anywhere: it lasts as long as the app.
 */

/** A command run in this session. */
export interface SessionCommand {
  command: string;
  /** Last run, in milliseconds since the Unix epoch. */
  at: number;
  count: number;
  /** The shell's folder, when it was known. */
  cwd?: string;
}

export interface TabHistory {
  /** Newest first, each command once. */
  session: SessionCommand[];
  /** From the shell's own history file, newest first, a page at a time. */
  earlier: string[];
  /** Older ones can be loaded. */
  more: boolean;
  /** Commands read from the file so far, removed ones included. */
  fetched: number;
}

export const emptyHistory: TabHistory = { session: [], earlier: [], more: false, fetched: 0 };

/** Earlier commands loaded when a tab opens, then for each "Load more". */
export const EARLIER_FIRST = 20;
export const EARLIER_MORE = 50;

export interface EarlierPage {
  commands: string[];
  more: boolean;
}

/** Adds a page of earlier commands; the file may have grown in between. */
export function withEarlier(history: TabHistory, page: EarlierPage, reset: boolean): TabHistory {
  const earlier = reset ? page.commands : [...new Set([...history.earlier, ...page.commands])];
  const fetched = (reset ? 0 : history.fetched) + page.commands.length;
  return { ...history, earlier, more: page.more, fetched };
}

/** Commands run in a tab, kept at most. */
const SESSION_MAX = 5_000;

export function withCommand(history: TabHistory, command: string, cwd?: string): TabHistory {
  const previous = history.session.find((c) => c.command === command);
  const entry: SessionCommand = { command, at: Date.now(), count: (previous?.count ?? 0) + 1, cwd };
  const rest = history.session.filter((c) => c.command !== command);
  return { ...history, session: [entry, ...rest].slice(0, SESSION_MAX) };
}

/** Earlier commands of a local shell; `shell` is its name ("zsh"). */
export const importLocalHistory = (profile: string, shell: string, offset: number, limit: number) =>
  invoke<EarlierPage>("history_import_local", { profile, shell, offset, limit });

/** Earlier commands on an SSH tab's server, read beside the shell. */
export const importSshHistory = (sessionId: number, offset: number, limit: number) =>
  invoke<EarlierPage>("history_import_ssh", { sessionId, offset, limit });

/** "just now", "5 min ago", "3 h ago", "yesterday", "Oct 4". */
export function timeAgo(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const day = new Date(at);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day.toDateString() === yesterday.toDateString()) return "yesterday";
  return day.toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** A multi-line command on one row. */
export const oneLine = (command: string) => command.replace(/\s*\n\s*/g, " ⏎ ");

/** The last two folders of a path: "…/src/app". */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join("/")}`;
}
