import { Channel, invoke } from "@tauri-apps/api/core";

export type FsTarget = { kind: "local" } | { kind: "ssh"; sessionId: number };

export type EntryKind = "dir" | "file" | "dirLink" | "link" | "other";

export interface Entry {
  name: string;
  kind: EntryKind;
  size: number;
  /** Seconds since the Unix epoch. */
  modified: number | null;
}

export interface Listing {
  path: string;
  entries: Entry[];
}

export type TransferEvent =
  | { type: "started"; totalBytes: number; totalFiles: number }
  | { type: "progress"; doneBytes: number; doneFiles: number; current: string }
  | { type: "finished" }
  | { type: "failed"; message: string }
  | { type: "cancelled" };

export const isFolder = (entry: Entry) => entry.kind === "dir" || entry.kind === "dirLink";

export const fsHome = (target: FsTarget) => invoke<string>("fs_home", { target });
export const fsList = (target: FsTarget, path: string) => invoke<Listing>("fs_list", { target, path });
export const fsMkdir = (target: FsTarget, path: string) => invoke<void>("fs_mkdir", { target, path });
export const fsRename = (target: FsTarget, from: string, to: string) =>
  invoke<void>("fs_rename", { target, from, to });
export const fsRemove = (target: FsTarget, paths: string[]) => invoke<void>("fs_remove", { target, paths });
export const fsExisting = (target: FsTarget, dir: string, names: string[]) =>
  invoke<string[]>("fs_existing", { target, dir, names });
export const openLocal = (path: string) => invoke<void>("fs_open_local", { path });
export const revealLocal = (path: string) => invoke<void>("fs_reveal_local", { path });
export const openRemote = (sessionId: number, path: string) => invoke<void>("fs_open_remote", { sessionId, path });
export const downloadsDir = () => invoke<string>("fs_downloads_dir");
export const terminalCwd = (id: number) => invoke<string | null>("terminal_cwd", { id });
export const cancelTransfer = (id: number) => invoke<void>("transfer_cancel", { id });

export function download(
  sessionId: number,
  remotePaths: string[],
  localDir: string,
  onEvent: (event: TransferEvent) => void,
) {
  const channel = new Channel<TransferEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("transfer_download", { sessionId, remotePaths, localDir, onEvent: channel });
}

export function upload(
  sessionId: number,
  localPaths: string[],
  remoteDir: string,
  onEvent: (event: TransferEvent) => void,
) {
  const channel = new Channel<TransferEvent>();
  channel.onmessage = onEvent;
  return invoke<number>("transfer_upload", { sessionId, localPaths, remoteDir, onEvent: channel });
}

/** Path helpers that work for both POSIX and Windows paths. */
export function separatorOf(path: string): "/" | "\\" {
  return /^[A-Za-z]:\\/.test(path) || (path.includes("\\") && !path.includes("/")) ? "\\" : "/";
}

export function joinPath(dir: string, name: string): string {
  const sep = separatorOf(dir);
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

export function parentPath(path: string): string {
  const sep = separatorOf(path);
  const trimmed = path.length > 1 && path.endsWith(sep) ? path.slice(0, -1) : path;
  const index = trimmed.lastIndexOf(sep);
  if (index < 0) return path;
  if (index === 0) return sep;
  // "C:\Users" -> "C:\"
  if (sep === "\\" && index === 2 && /^[A-Za-z]:/.test(trimmed)) return trimmed.slice(0, 3);
  return trimmed.slice(0, index);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** Quotes a path for the shell the panel would `cd` in. */
export function cdCommand(path: string, shell: "posix" | "powershell" | "cmd"): string {
  switch (shell) {
    case "powershell":
      return `Set-Location -LiteralPath '${path.replace(/'/g, "''")}'\r`;
    case "cmd":
      return `cd /d "${path}"\r`;
    default:
      return `cd -- '${path.replace(/'/g, `'\\''`)}'\r`;
  }
}
