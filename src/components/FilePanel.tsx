import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Tab } from "../App";
import { opensInEditor, type FileOrigin } from "../lib/editor";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { isMac, platform } from "../lib/platform";
import {
  cancelTransfer,
  cdCommand,
  download,
  downloadsDir,
  formatSize,
  fsExisting,
  fsHome,
  fsList,
  fsMkdir,
  fsRemove,
  fsRename,
  isFolder,
  joinPath,
  openLocal,
  openRemote,
  parentPath,
  revealLocal,
  terminalCwd,
  upload,
  type Entry,
  type FsTarget,
  type TransferEvent,
} from "../lib/files";

interface Props {
  tab: Tab | null;
  /** For an editor tab of a remote file: the SSH tab it came from. */
  sourceTab: Tab | null;
  /** Opens a file in an editor tab; rejects with a readable reason. */
  onEdit(origin: FileOrigin, path: string, name: string): Promise<void>;
  /** Types text into the active terminal. */
  sendToTerminal(text: string): void;
  /** Changes when a file was saved elsewhere in the app. */
  refreshKey: number;
}

type Source =
  | {
      status: "ready";
      key: string;
      target: FsTarget;
      origin: FileOrigin;
      where: string;
      shell: "posix" | "powershell" | "cmd" | null;
      start(): Promise<string>;
    }
  | { status: "waiting"; message: string };

interface Transfer {
  key: number;
  id?: number;
  verb: "Downloading" | "Uploading";
  label: string;
  totalBytes: number;
  doneBytes: number;
  status: "running" | "done" | "failed" | "cancelled";
  message?: string;
  reveal?: string;
}

type Editing = { mode: "rename"; name: string } | { mode: "new" } | null;
type Confirm = { title: string; body: string; confirm: string; danger?: boolean; run(): void } | null;

const revealLabel = platform === "mac" ? "Show in Finder" : platform === "windows" ? "Show in Explorer" : "Show in Files";
const thisComputer = platform === "mac" ? "this Mac" : "this computer";

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === "1";
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // Not remembering a preference is fine.
  }
}

function shellOf(tab: Tab): "posix" | "powershell" | "cmd" | null {
  if (tab.target.kind === "ssh") return "posix";
  if (platform !== "windows") return "posix";
  if (tab.target.kind !== "local") return null;
  const id = tab.target.profileId;
  if (id === "cmd") return "cmd";
  // A WSL shell sees Linux paths, not the Windows ones listed here.
  if (id.startsWith("wsl:")) return null;
  return "powershell";
}

function sourceOf(tab: Tab | null, sourceTab: Tab | null): Source {
  const local: FileOrigin = { kind: "local" };
  if (!tab || tab.target.kind === "settings") {
    return { status: "ready", key: "none", target: { kind: "local" }, origin: local, where: thisComputer, shell: null, start: () => fsHome({ kind: "local" }) };
  }
  if (tab.target.kind === "editor") {
    // An editor shows the folder of its file, on the machine it came from.
    const { file } = tab.target;
    const folder = parentPath(file.path);
    if (file.origin.kind === "local") {
      return { status: "ready", key: tab.id, target: { kind: "local" }, origin: local, where: thisComputer, shell: null, start: async () => folder };
    }
    const name = file.origin.serverName;
    if (!sourceTab) return { status: "waiting", message: `The ${name} session this file came from is closed.` };
    if (sourceTab.state !== "live" || sourceTab.sessionId === undefined) {
      return { status: "waiting", message: `Reconnect ${name} to see its files.` };
    }
    return {
      status: "ready",
      key: tab.id,
      target: { kind: "ssh", sessionId: sourceTab.sessionId },
      origin: file.origin,
      where: name,
      shell: "posix",
      start: async () => folder,
    };
  }
  if (tab.target.kind === "local") {
    if (tab.sessionId === undefined) return { status: "waiting", message: "Starting the shell…" };
    const sessionId = tab.sessionId;
    return {
      status: "ready",
      key: `${tab.id}:${tab.generation}`,
      target: { kind: "local" },
      origin: local,
      where: thisComputer,
      shell: tab.state === "ended" ? null : shellOf(tab),
      start: async () => tab.cwd ?? (await terminalCwd(sessionId).catch(() => null)) ?? fsHome({ kind: "local" }),
    };
  }
  const name = tab.target.name;
  if (tab.state === "connecting" || tab.sessionId === undefined) {
    return { status: "waiting", message: `Connecting to ${name}…` };
  }
  if (tab.state === "ended") return { status: "waiting", message: `Reconnect to see the files on ${name}.` };
  const target: FsTarget = { kind: "ssh", sessionId: tab.sessionId };
  return {
    status: "ready",
    key: `${tab.id}:${tab.generation}`,
    target,
    origin: { kind: "ssh", tabId: tab.id, serverName: name },
    where: name,
    shell: "posix",
    start: async () => tab.cwd ?? fsHome(target),
  };
}

const FolderIcon = ({ link }: { link?: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" className="file-icon file-icon-folder">
    <path d="M1.5 4.2c0-.7.5-1.2 1.2-1.2h3.4l1.5 1.6h5.7c.7 0 1.2.5 1.2 1.2v6.5c0 .7-.5 1.2-1.2 1.2H2.7c-.7 0-1.2-.5-1.2-1.2z" fill="currentColor" />
    {link && <path d="M7 10.5l3-3m0 0H7.8M10 7.5v2.2" stroke="var(--term-bg)" strokeWidth="1.3" strokeLinecap="round" fill="none" />}
  </svg>
);

const FileIcon = ({ link }: { link?: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" className="file-icon">
    <path d="M3.5 1.8h5.6l3.4 3.4v9H3.5z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    <path d="M9 1.8v3.5h3.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    {link && <path d="M6 11.5l3-3m0 0H6.8M9 8.5v2.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none" />}
  </svg>
);

const Button = ({ label, onClick, disabled, children }: { label: string; onClick(): void; disabled?: boolean; children: React.ReactNode }) => (
  <button type="button" className="icon-button" aria-label={label} title={label} onClick={onClick} disabled={disabled}>
    {children}
  </button>
);

let transferKey = 0;

export function FilePanel({ tab, sourceTab, onEdit, sendToTerminal, refreshKey }: Props) {
  const source = useMemo(() => sourceOf(tab, sourceTab), [tab, sourceTab]);
  const ready = source.status === "ready" ? source : null;

  const [path, setPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(() => readFlag("chappe.showHidden", false));
  const [follow, setFollow] = useState(() => readFlag("chappe.followTerminal", true));
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState<Editing>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);

  const memory = useRef(new Map<string, string>());
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: "", at: 0 });
  // The listing in flight; older answers are dropped.
  const request = useRef(0);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter((e) => (showHidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)));
  }, [entries, filter, showHidden]);
  const hiddenCount = entries.length - entries.filter((e) => showHidden || !e.name.startsWith(".")).length;

  const load = useCallback(
    async (target: FsTarget, key: string, to: string, keepSelection = false) => {
      const id = ++request.current;
      setLoading(true);
      try {
        const listing = await fsList(target, to);
        if (id !== request.current) return;
        memory.current.set(key, listing.path);
        setPath(listing.path);
        setPathDraft(listing.path);
        setEntries(listing.entries);
        setError(null);
        if (!keepSelection) {
          setSelected(new Set());
          setCursor(0);
          setFilter("");
        } else {
          setSelected((s) => new Set([...s].filter((name) => listing.entries.some((e) => e.name === name))));
        }
      } catch (e) {
        if (id === request.current) setError(String(e));
      } finally {
        if (id === request.current) setLoading(false);
      }
    },
    [],
  );

  // A new tab, or the same tab connected again: go to its remembered folder.
  useEffect(() => {
    if (!ready) {
      request.current++;
      setPath(null);
      setEntries([]);
      setError(null);
      return;
    }
    const remembered = memory.current.get(ready.key);
    setEditing(null);
    setMenu(null);
    (async () => {
      const start = remembered ?? (await ready.start().catch(() => null)) ?? "/";
      await load(ready.target, ready.key, start);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready?.key, load]);

  // Shells that report their folder (OSC 7) take the panel along.
  const cwd = tab?.cwd;
  useEffect(() => {
    if (ready && follow && cwd && cwd !== memory.current.get(ready.key)) void load(ready.target, ready.key, cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, follow]);

  const go = (to: string) => ready && void load(ready.target, ready.key, to);
  // Transfers finish later; they must refresh the folder shown then, not
  // the one shown when they started.
  const latest = useRef({ ready, path });
  latest.current = { ready, path };
  const refresh = () => {
    const { ready: current, path: shown } = latest.current;
    if (current && shown) void load(current.target, current.key, shown, true);
  };
  const full = (name: string) => (path ? joinPath(path, name) : name);

  useEffect(() => {
    if (refreshKey) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const goToTerminalFolder = async () => {
    if (!ready || !tab) return;
    const folder = tab.cwd ?? (tab.target.kind === "local" && tab.sessionId !== undefined ? await terminalCwd(tab.sessionId) : null);
    if (folder) go(folder);
    else setNotice(tab.target.kind === "ssh" ? "This server's shell doesn't report its folder." : "Couldn't read the shell's folder.");
  };

  const selection = (): Entry[] => visible.filter((e) => selected.has(e.name));

  const editEntry = async (entry: Entry) => {
    if (!ready) return;
    setNotice(`Opening ${entry.name}…`);
    try {
      await onEdit(ready.origin, full(entry.name), entry.name);
      setNotice(null);
    } catch (e) {
      setNotice(`Couldn't open ${entry.name}: ${String(e).replace(/^Error: /, "")}`);
    }
  };

  /** Folders open in the panel, text files in the editor, the rest in their app. */
  const openEntry = async (entry: Entry) => {
    if (!ready) return;
    if (isFolder(entry)) return go(full(entry.name));
    if (opensInEditor(entry.name)) return editEntry(entry);
    return openDefault(entry);
  };

  const openDefault = async (entry: Entry) => {
    if (!ready) return;
    try {
      if (ready.target.kind === "local") await openLocal(full(entry.name));
      else {
        setNotice(`Opening ${entry.name}…`);
        await openRemote(ready.target.sessionId, full(entry.name));
        setNotice(null);
      }
    } catch (e) {
      setNotice(String(e));
    }
  };

  // ---------- Transfers ----------

  const track = (verb: Transfer["verb"], label: string, reveal?: string) => {
    const key = ++transferKey;
    setTransfers((list) => [...list, { key, verb, label, totalBytes: 0, doneBytes: 0, status: "running", reveal }]);
    const update = (patch: Partial<Transfer>) =>
      setTransfers((list) => list.map((t) => (t.key === key ? { ...t, ...patch } : t)));
    const onEvent = (event: TransferEvent) => {
      switch (event.type) {
        case "started":
          return update({ totalBytes: event.totalBytes });
        case "progress":
          return update({ doneBytes: event.doneBytes });
        case "finished":
          update({ status: "done" });
          refresh();
          // Finished transfers clear themselves after a while.
          setTimeout(() => setTransfers((list) => list.filter((t) => t.key !== key)), 8000);
          return;
        case "failed":
          return update({ status: "failed", message: event.message });
        case "cancelled":
          update({ status: "cancelled" });
          setTimeout(() => setTransfers((list) => list.filter((t) => t.key !== key)), 3000);
          return;
      }
    };
    return { onEvent, setId: (id: number) => update({ id }) };
  };

  const describeItems = (names: string[]) => (names.length === 1 ? names[0] : `${names.length} items`);

  const downloadTo = async (items: Entry[], dir?: string) => {
    if (!ready || ready.target.kind !== "ssh" || !items.length) return;
    const destination = dir ?? (await downloadsDir());
    const names = items.map((e) => e.name);
    const t = track("Downloading", describeItems(names), items.length === 1 ? joinPath(destination, names[0]) : destination);
    try {
      t.setId(await download(ready.target.sessionId, names.map(full), destination, t.onEvent));
    } catch (e) {
      t.onEvent({ type: "failed", message: String(e) });
    }
  };

  const uploadPaths = async (localPaths: string[]) => {
    if (!ready || ready.target.kind !== "ssh" || !path || !localPaths.length) return;
    const sessionId = ready.target.sessionId;
    const target = ready.target;
    const dir = path;
    const names = localPaths.map((p) => p.split(/[\\/]/).filter(Boolean).pop() ?? p);
    const start = async () => {
      const t = track("Uploading", describeItems(names));
      try {
        t.setId(await upload(sessionId, localPaths, dir, t.onEvent));
      } catch (e) {
        t.onEvent({ type: "failed", message: String(e) });
      }
    };
    const existing = await fsExisting(target, dir, names).catch(() => []);
    if (existing.length) {
      setConfirm({
        title: existing.length === 1 ? `Replace ${existing[0]}?` : `Replace ${existing.length} items?`,
        body: `${existing.length === 1 ? "It already exists" : "They already exist"} in ${dir}. Folders are merged, and files with the same name are replaced.`,
        confirm: "Replace",
        danger: true,
        run: () => void start(),
      });
    } else {
      void start();
    }
  };

  const pickAndUpload = async () => {
    const picked = await openDialog({ title: "Upload files", multiple: true });
    if (picked) await uploadPaths(Array.isArray(picked) ? picked : [picked]);
  };

  const pickAndDownload = async (items: Entry[]) => {
    const picked = await openDialog({ title: "Download to", directory: true, defaultPath: await downloadsDir() });
    if (typeof picked === "string") await downloadTo(items, picked);
  };

  // Files dropped from the Finder / Explorer onto the panel are uploaded.
  useEffect(() => {
    const remote = ready?.target.kind === "ssh";
    let off: (() => void) | undefined;
    const inside = (x: number, y: number) => {
      const rect = panelRef.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      return !!rect && x / scale >= rect.left && x / scale <= rect.right && y / scale >= rect.top && y / scale <= rect.bottom;
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over" || p.type === "enter") setDropActive(remote && inside(p.position.x, p.position.y));
        else if (p.type === "leave") setDropActive(false);
        else if (p.type === "drop") {
          setDropActive(false);
          if (remote && inside(p.position.x, p.position.y)) void uploadPaths(p.paths);
        }
      })
      .then((unlisten) => (off = unlisten));
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready?.key, path]);

  // ---------- Changes ----------

  const askDelete = (items: Entry[]) => {
    if (!ready || !items.length) return;
    const names = items.map((e) => e.name);
    const local = ready.target.kind === "local";
    setConfirm({
      title: local ? `Move ${describeItems(names)} to the Trash?` : `Delete ${describeItems(names)}?`,
      body: (() => {
        const one = names.length === 1;
        const folders = items.some(isFolder) ? (one ? " with everything in it" : ", folders with everything in them") : "";
        return local
          ? `You can restore ${one ? "it" : "them"} from the Trash.`
          : `${one ? "It" : "They"} will be deleted from ${ready.where} for good${folders}.`;
      })(),
      confirm: local ? "Move to Trash" : "Delete",
      danger: !local,
      run: async () => {
        try {
          await fsRemove(ready.target, names.map(full));
        } catch (e) {
          setNotice(String(e));
        }
        refresh();
      },
    });
  };

  // After a menu or an inline edit, the keyboard goes back to the list.
  // Only when nothing else took it: "Open in terminal" hands it to the shell.
  const focusList = () =>
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!active || active === document.body || active.closest(".context-menu, .modal-layer")) {
        listRef.current?.focus();
      }
    });

  const cancelEdit = () => {
    setEditing(null);
    focusList();
  };

  const commitEdit = async (value: string) => {
    const current = editing;
    setEditing(null);
    focusList();
    const name = value.trim();
    if (!ready || !current || !name || /[\\/]/.test(name)) return;
    try {
      if (current.mode === "new") await fsMkdir(ready.target, full(name));
      else if (name !== current.name) await fsRename(ready.target, full(current.name), full(name));
      else return;
      await load(ready.target, ready.key, path!, true);
      setSelected(new Set([name]));
    } catch (e) {
      setNotice(String(e));
    }
  };

  const copyPaths = (items: Entry[]) => void writeText(items.map((e) => full(e.name)).join("\n"));

  // ---------- Menus ----------

  const itemMenu = (items: Entry[]): MenuItem[] => {
    if (!ready) return [];
    const one = items.length === 1 ? items[0] : null;
    const remote = ready.target.kind === "ssh";
    const list: MenuItem[] = [];
    if (one && isFolder(one)) list.push({ label: "Open", onSelect: () => void openEntry(one), hint: "↵" });
    if (one && !isFolder(one)) {
      list.push({ label: "Edit", onSelect: () => void editEntry(one), hint: opensInEditor(one.name) ? "↵" : undefined });
      list.push({
        label: "Open with default app",
        onSelect: () => void openDefault(one),
        hint: opensInEditor(one.name) ? undefined : "↵",
      });
    }
    if (one && isFolder(one) && ready.shell) {
      const shell = ready.shell;
      list.push({ label: "Open in terminal", onSelect: () => sendToTerminal(cdCommand(full(one.name), shell)) });
    }
    list.push("separator");
    if (remote) {
      list.push({ label: "Download", onSelect: () => void downloadTo(items) });
      list.push({ label: "Download to…", onSelect: () => void pickAndDownload(items) });
    } else if (one) {
      list.push({ label: revealLabel, onSelect: () => void revealLocal(full(one.name)) });
    }
    list.push({ label: items.length > 1 ? "Copy paths" : "Copy path", onSelect: () => copyPaths(items) });
    list.push("separator");
    if (one) list.push({ label: "Rename", onSelect: () => setEditing({ mode: "rename", name: one.name }), hint: "F2" });
    list.push({
      label: remote ? "Delete" : "Move to Trash",
      danger: true,
      onSelect: () => askDelete(items),
      hint: isMac ? "⌘⌫" : "Del",
    });
    return list;
  };

  const folderMenu = (): MenuItem[] => {
    if (!ready || !path) return [];
    const remote = ready.target.kind === "ssh";
    const list: MenuItem[] = [{ label: "New folder", onSelect: () => setEditing({ mode: "new" }) }];
    if (remote) list.push({ label: "Upload files…", onSelect: () => void pickAndUpload() });
    if (ready.shell) {
      const shell = ready.shell;
      list.push({ label: "Open in terminal", onSelect: () => sendToTerminal(cdCommand(path, shell)) });
    }
    if (!remote) list.push({ label: revealLabel, onSelect: () => void revealLocal(path) });
    list.push("separator");
    list.push({
      label: showHidden ? "Hide hidden files" : "Show hidden files",
      onSelect: () => {
        writeFlag("chappe.showHidden", !showHidden);
        setShowHidden(!showHidden);
      },
    });
    list.push({
      label: follow ? "Stop following the terminal" : "Follow the terminal's folder",
      onSelect: () => {
        writeFlag("chappe.followTerminal", !follow);
        setFollow(!follow);
      },
    });
    list.push({ label: "Refresh", onSelect: refresh });
    return list;
  };

  // ---------- Selection and keyboard ----------

  const selectRow = (index: number, e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    const entry = visible[index];
    if (!entry) return;
    if (e.shiftKey) {
      const [from, to] = [Math.min(cursor, index), Math.max(cursor, index)];
      setSelected(new Set(visible.slice(from, to + 1).map((v) => v.name)));
    } else if (isMac ? e.metaKey : e.ctrlKey) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(entry.name)) next.delete(entry.name);
        else next.add(entry.name);
        return next;
      });
      setCursor(index);
    } else {
      setSelected(new Set([entry.name]));
      setCursor(index);
    }
  };

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const onListKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const move = (to: number) => {
      const index = Math.max(0, Math.min(visible.length - 1, to));
      selectRow(index, { metaKey: false, ctrlKey: false, shiftKey: e.shiftKey });
      if (e.shiftKey) setCursor(index);
    };
    if (e.key === "ArrowDown") move(cursor + 1);
    else if (e.key === "ArrowUp" && !mod) move(cursor - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(visible.length - 1);
    else if (e.key === "Enter" && visible[cursor]) void openEntry(visible[cursor]);
    else if ((e.key === "ArrowUp" && mod) || (e.key === "Backspace" && !mod)) path && go(parentPath(path));
    else if (e.key === "Delete" || (e.key === "Backspace" && mod)) askDelete(selection());
    else if (e.key === "F2" && visible[cursor]) setEditing({ mode: "rename", name: visible[cursor].name });
    else if (mod && e.code === "KeyA") setSelected(new Set(visible.map((v) => v.name)));
    else if (e.key.length === 1 && !mod && !e.altKey) {
      // Type the start of a name to jump to it.
      const now = Date.now();
      const text = (now - typeahead.current.at < 700 ? typeahead.current.text : "") + e.key.toLowerCase();
      typeahead.current = { text, at: now };
      const index = visible.findIndex((v) => v.name.toLowerCase().startsWith(text));
      if (index >= 0) move(index);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), Math.max(5000, notice.length * 80));
    return () => clearTimeout(timer);
  }, [notice]);

  // ---------- Render ----------

  const remote = ready?.target.kind === "ssh";
  const status = (() => {
    if (!ready || !path) return "";
    // One item selected: say what it is.
    const one = selected.size === 1 ? visible.find((e) => selected.has(e.name)) : undefined;
    if (one) {
      const when = one.modified
        ? new Date(one.modified * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
        : null;
      const size = one.kind === "file" ? formatSize(one.size) : isFolder(one) ? "Folder" : "Link";
      return when ? `${size}, modified ${when}` : size;
    }
    const count = `${visible.length} ${visible.length === 1 ? "item" : "items"}`;
    const hidden = !showHidden && hiddenCount ? `, ${hiddenCount} hidden` : "";
    const chosen = selected.size > 1 ? `, ${selected.size} selected` : "";
    return count + hidden + chosen;
  })();

  return (
    <aside className="files" ref={panelRef} data-drop={dropActive} aria-label="Files">
      <div className="files-titlebar" data-tauri-drag-region>
        <h2 className="files-title" data-tauri-drag-region>
          Files
          {ready && <span className="files-where"> on {ready.where}</span>}
        </h2>
        <span className="files-actions">
          <Button label="Go to the terminal's folder" onClick={() => void goToTerminalFolder()} disabled={!ready || !tab}>
            <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="7" cy="7" r="1.5" fill="currentColor" />
              <path d="M7 .8v2M7 11.2v2M.8 7h2M11.2 7h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </Button>
          <Button label="Refresh" onClick={refresh} disabled={!ready}>
            <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M11.8 7A4.8 4.8 0 113.4 3.8M3 1.5v2.6h2.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Button>
          <Button
            label="More"
            disabled={!ready || !path}
            onClick={() => {
              const rect = panelRef.current?.querySelector(".files-actions")?.getBoundingClientRect();
              setMenu({ x: rect ? rect.right - 200 : 40, y: rect ? rect.bottom + 4 : 40, items: folderMenu() });
            }}
          >
            <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
              <circle cx="3" cy="7" r="1.2" fill="currentColor" />
              <circle cx="7" cy="7" r="1.2" fill="currentColor" />
              <circle cx="11" cy="7" r="1.2" fill="currentColor" />
            </svg>
          </Button>
        </span>
      </div>

      {source.status === "waiting" ? (
        <p className="files-message">{source.message}</p>
      ) : (
        <>
          <form
            className="files-path"
            onSubmit={(e) => {
              e.preventDefault();
              if (pathDraft.trim()) go(pathDraft.trim());
            }}
          >
            <Button label="Parent folder" onClick={() => path && go(parentPath(path))} disabled={!path}>
              <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
                <path d="M7 12V2.5M3 6.5l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Button>
            <input
              className="files-input"
              value={pathDraft}
              aria-label="Folder path"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setPathDraft(e.target.value)}
              onFocus={(e) => e.target.select()}
              onBlur={() => path && setPathDraft(path)}
              onKeyDown={(e) => e.key === "Escape" && (path && setPathDraft(path), e.currentTarget.blur())}
            />
          </form>
          <input
            className="files-input files-filter"
            type="search"
            value={filter}
            placeholder="Filter"
            aria-label="Filter files"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setFilter("");
              if (e.key === "ArrowDown") {
                e.preventDefault();
                listRef.current?.focus();
              }
            }}
          />

          <div
            ref={listRef}
            className="files-list"
            role="listbox"
            aria-multiselectable="true"
            aria-label={`Files in ${path ?? ""}`}
            tabIndex={0}
            data-loading={loading}
            onKeyDown={onListKey}
            onContextMenu={(e) => {
              e.preventDefault();
              if ((e.target as HTMLElement).closest(".file-row")) return;
              setSelected(new Set());
              setMenu({ x: e.clientX, y: e.clientY, items: folderMenu() });
            }}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setSelected(new Set());
            }}
          >
            {editing?.mode === "new" && (
              <div className="file-row" data-editing="true">
                <FolderIcon />
                <NameEditor initial="New folder" onDone={commitEdit} onCancel={cancelEdit} />
              </div>
            )}
            {error ? (
              <div className="files-error" role="alert">
                <p>{error}</p>
                <button type="button" className="button-quiet button-small" onClick={() => ready && void ready.start().then(go)}>
                  Go to the start folder
                </button>
              </div>
            ) : (
              visible.map((entry, index) => {
                const renaming = editing?.mode === "rename" && editing.name === entry.name;
                return (
                  <div
                    key={entry.name}
                    className="file-row"
                    role="option"
                    data-index={index}
                    aria-selected={selected.has(entry.name)}
                    data-cursor={index === cursor}
                    data-kind={entry.kind}
                    onMouseDown={(e) => {
                      if (e.button === 0) selectRow(index, e);
                    }}
                    onDoubleClick={() => void openEntry(entry)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      const items = selected.has(entry.name) ? selection() : [entry];
                      if (!selected.has(entry.name)) {
                        setSelected(new Set([entry.name]));
                        setCursor(index);
                      }
                      setMenu({ x: e.clientX, y: e.clientY, items: itemMenu(items) });
                    }}
                  >
                    {isFolder(entry) ? <FolderIcon link={entry.kind === "dirLink"} /> : <FileIcon link={entry.kind === "link"} />}
                    {renaming ? (
                      <NameEditor initial={entry.name} onDone={commitEdit} onCancel={cancelEdit} />
                    ) : (
                      <span className="file-name">{entry.name}</span>
                    )}
                    {entry.kind === "file" && <span className="file-size">{formatSize(entry.size)}</span>}
                  </div>
                );
              })
            )}
            {!error && path && visible.length === 0 && !editing && (
              <p className="files-empty">{filter ? `Nothing matches “${filter}”.` : "This folder is empty."}</p>
            )}
          </div>
        </>
      )}

      {dropActive && <div className="files-drop">Drop to upload to {path}</div>}

      {transfers.length > 0 && (
        <ul className="transfers" aria-label="Transfers">
          {transfers.map((t) => {
            const percent = t.totalBytes ? Math.min(100, Math.round((t.doneBytes / t.totalBytes) * 100)) : 0;
            return (
              <li key={t.key} className="transfer" data-status={t.status}>
                <div className="transfer-line">
                  <span className="transfer-label">
                    {t.status === "running"
                      ? `${t.verb} ${t.label}`
                      : t.status === "done"
                        ? `${t.verb === "Downloading" ? "Downloaded" : "Uploaded"} ${t.label}`
                        : t.status === "cancelled"
                          ? `Cancelled ${t.label}`
                          : `Couldn't ${t.verb === "Downloading" ? "download" : "upload"} ${t.label}`}
                  </span>
                  {t.status === "running" && <span className="transfer-percent">{percent}%</span>}
                  {t.status === "running" && t.id !== undefined && (
                    <button type="button" className="link-button" onClick={() => void cancelTransfer(t.id!)}>
                      Cancel
                    </button>
                  )}
                  {t.status === "done" && t.reveal && (
                    <button type="button" className="link-button" onClick={() => void revealLocal(t.reveal!)}>
                      Show
                    </button>
                  )}
                  {(t.status === "failed" || t.status === "cancelled") && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setTransfers((list) => list.filter((x) => x.key !== t.key))}
                    >
                      Dismiss
                    </button>
                  )}
                </div>
                {t.status === "running" && (
                  <div className="transfer-bar" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
                    <span style={{ width: `${percent}%` }} />
                  </div>
                )}
                {t.message && <p className="transfer-error">{t.message}</p>}
              </li>
            );
          })}
        </ul>
      )}

      <footer className="files-status" role="status" data-notice={Boolean(notice)}>
        <span className="files-status-text">{notice ?? status}</span>
        {remote && !notice && path && (
          <button type="button" className="link-button files-upload" onClick={() => void pickAndUpload()}>
            Upload…
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
            focusList();
          }}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirm={confirm.confirm}
          danger={confirm.danger}
          onCancel={() => {
            setConfirm(null);
            focusList();
          }}
          onConfirm={() => {
            const run = confirm.run;
            setConfirm(null);
            focusList();
            run();
          }}
        />
      )}
    </aside>
  );
}

function NameEditor({ initial, onDone, onCancel }: { initial: string; onDone(value: string): void; onCancel(): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // Select the name without its extension, as Finder does.
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    if (value === null) onCancel();
    else onDone(value);
  };
  return (
    <input
      ref={ref}
      className="file-rename"
      defaultValue={initial}
      spellCheck={false}
      aria-label="Name"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish(null);
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
