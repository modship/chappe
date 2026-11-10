import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FilePanel } from "./components/FilePanel";
import { TabBar } from "./components/TabBar";
import { StatusBar } from "./components/StatusBar";
import { EmptyState } from "./components/EmptyState";
import { ServerDialog } from "./components/ServerDialog";
import { Splitter } from "./components/Splitter";
import { SessionPalette, choiceKey, type PaletteChoice } from "./components/SessionPalette";
import { TerminalView, type SessionState, type TerminalApi } from "./components/TerminalView";
import { CodeEditor, type EditorApi } from "./components/CodeEditor";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HistoryPanel } from "./components/HistoryPanel";
import {
  EARLIER_FIRST,
  EARLIER_MORE,
  emptyHistory,
  importLocalHistory,
  importSshHistory,
  withCommand,
  withEarlier,
  type TabHistory,
} from "./lib/history";
import type { Busy } from "./lib/commandCapture";
import { SettingsPage } from "./components/SettingsPage";
import { UpdateDialog } from "./components/UpdateDialog";
import {
  CHECK_INTERVAL,
  FIRST_CHECK_DELAY,
  appVersion,
  checkForUpdate,
  updatesConfigured,
  type Update,
} from "./lib/updates";
import { DEFAULT_SETTINGS, applyInterface, saveSettings, type Settings } from "./lib/settings";
import { applyTheme, themeById, uiColors } from "./lib/themes";
import { shellName, tabLabel } from "./lib/title";
import { readTextFile, sameOrigin, type EditorFile, type FileOrigin } from "./lib/editor";
import type { FsTarget } from "./lib/files";
import { matchShortcut, type Action } from "./lib/shortcuts";
import { listServers, type ServerEntry } from "./lib/servers";
import { DEFAULT_PROFILE, listProfiles, type LocalProfile } from "./lib/local";

export type TabTarget =
  | { kind: "local"; profileId: string; name?: string }
  | { kind: "ssh"; serverId: string; name: string }
  | { kind: "editor"; file: EditorFile }
  | { kind: "settings" };

export interface Tab {
  id: string;
  target: TabTarget;
  /** Bumped on reconnect: a new value remounts the terminal. */
  generation: number;
  state: SessionState;
  title: string;
  /** The Rust session behind the terminal, once started. */
  sessionId?: number;
  /** The shell's folder, when it reports it. */
  cwd?: string;
  shell?: string;
  address?: string;
  cols?: number;
  rows?: number;
  /** Editor tabs: unsaved changes, caret position, language, line endings. */
  dirty?: boolean;
  cursor?: { line: number; col: number };
  language?: string;
  eol?: "LF" | "CRLF";
}

const SIDEBAR_DEFAULT = 260;
const SIDEBAR_MIN = 200;
const HISTORY_DEFAULT = 300;
const HISTORY_MIN = 220;
const PANEL_MAX = 640;
/** Keeps at least this much room for the terminals. */
const TERMINAL_MIN = 360;

const fileName = (tab: Tab) => (tab.target.kind === "editor" ? tab.target.file.name : tabLabel(tab).main);

/** How the history panel names a terminal tab. */
function terminalLabel(tab: Tab | null): string | null {
  if (tab?.target.kind === "local") return tab.target.name ?? shellName(tab.shell);
  if (tab?.target.kind === "ssh") return tab.target.name;
  return null;
}

const busyText: Record<Busy, string> = {
  fullscreen: "A full-screen program is open in this terminal. Quit it first, or use Insert.",
  running: "A command is still running in this terminal.",
  typing: "Something is already typed in this terminal. Clear the line first, or use Insert.",
};

function readNumber(key: string, fallback: number, min: number): number {
  try {
    const value = Number(localStorage.getItem(key));
    return Number.isFinite(value) && value >= min ? value : fallback;
  } catch {
    return fallback;
  }
}

function readJson<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
  } catch {
    // Preferences that can't be kept are only a convenience lost.
  }
}

let tabCounter = 0;
const newTab = (target: TabTarget): Tab => ({
  id: `tab-${++tabCounter}`,
  target,
  generation: 0,
  state: target.kind === "settings" ? "live" : "connecting",
  title: "",
});
/** Oldest first, whatever order the tab bar shows. */
const byCreation = (a: Tab, b: Tab) => Number(a.id.slice(4)) - Number(b.id.slice(4));

type Dialog = { server: ServerEntry | null } | null;

const isTextField = (element: Element | null) =>
  element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;

export default function App({ initialSettings }: { initialSettings: Settings }) {
  const [settings, setSettings] = useState(initialSettings);
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab({ kind: "local", profileId: DEFAULT_PROFILE })]);
  const [activeId, setActiveId] = useState<string | null>(() => tabs[0]?.id ?? null);
  const [profiles, setProfiles] = useState<LocalProfile[]>([]);
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [configError, setConfigError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [palette, setPalette] = useState(false);
  const [recent, setRecent] = useState<Record<string, number>>(() => readJson("chappe.recent", {}));
  const [filesVisible, setFilesVisible] = useState(() => readJson("chappe.filesVisible", true));
  const [sidebarWidth, setSidebarWidth] = useState(() => readNumber("chappe.sidebarWidth", SIDEBAR_DEFAULT, SIDEBAR_MIN));
  const [historyVisible, setHistoryVisible] = useState(() => readJson("chappe.historyVisible", true));
  const [historyWidth, setHistoryWidth] = useState(() => readNumber("chappe.historyWidth", HISTORY_DEFAULT, HISTORY_MIN));
  /** Per tab, in memory only. */
  const [histories, setHistories] = useState<Record<string, TabHistory>>({});
  /** The tab generation whose earlier history was asked for. */
  const imported = useRef(new Map<string, number>());
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  // The files panel comes first; the history panel gets what is left.
  const sidebarMax = Math.max(
    SIDEBAR_MIN,
    Math.min(PANEL_MAX, windowWidth - TERMINAL_MIN - (historyVisible ? HISTORY_MIN : 0)),
  );
  const width = Math.min(sidebarWidth, sidebarMax);
  const historyMax = Math.max(
    HISTORY_MIN,
    Math.min(PANEL_MAX, windowWidth - TERMINAL_MIN - (filesVisible ? width : 0)),
  );
  const historyShown = Math.min(historyWidth, historyMax);
  const apis = useRef(new Map<string, TerminalApi>());
  const editors = useRef(new Map<string, EditorApi>());
  /** Tabs being closed while some have unsaved changes. */
  const [closing, setClosing] = useState<{ ids: string[]; dirty: Tab[] } | null>(null);
  const [quitting, setQuitting] = useState(0);
  /** Bumped when a file is saved, so the file panel shows the new size. */
  const [filesVersion, setFilesVersion] = useState(0);

  // Shortcut and menu handlers are registered once; they read the latest
  // state through this ref.
  const state = useRef({ tabs, activeId });
  state.current = { tabs, activeId };

  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // The theme reaches the interface, and the window itself (title bar,
  // traffic lights, the colour shown while resizing).
  useEffect(() => {
    const theme = themeById(settings.theme);
    applyTheme(theme);
    const window = getCurrentWindow();
    window.setTheme(theme.light ? "light" : "dark").catch(() => {});
    window.setBackgroundColor(uiColors(theme).chrome).catch(() => {});
  }, [settings.theme]);

  useEffect(() => applyInterface(settings), [settings]);

  // ---------- Updates ----------
  const [version, setVersion] = useState("");
  const [canUpdate, setCanUpdate] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);

  useEffect(() => {
    appVersion().then(setVersion, () => {});
    void updatesConfigured().then(setCanUpdate);
  }, []);

  // A quiet look now and then; a failure (offline, no release yet) says nothing.
  useEffect(() => {
    if (!canUpdate || !settings.autoUpdateCheck) return;
    const look = () =>
      checkForUpdate()
        .then((found) => found && setUpdate(found))
        .catch((e) => console.warn("update check", e));
    const first = window.setTimeout(look, FIRST_CHECK_DELAY);
    const every = window.setInterval(look, CHECK_INTERVAL);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [canUpdate, settings.autoUpdateCheck]);

  // Saved shortly after the last change, not on every step of a slider.
  const saveTimer = useRef(0);
  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveSettings(next).catch((e) => console.error("settings_save", e));
      }, 300);
      return next;
    });
  }, []);

  const updateHistory = useCallback((id: string, change: (history: TabHistory) => TabHistory) => {
    setHistories((all) => ({ ...all, [id]: change(all[id] ?? emptyHistory) }));
  }, []);

  const recordCommand = useCallback(
    (tab: Tab, command: string) => updateHistory(tab.id, (h) => withCommand(h, command, tab.cwd)),
    [updateHistory],
  );

  /** Reads a page of what a tab's shell ran before, from its own history file. */
  const loadEarlier = useCallback(
    async (tab: Tab, offset: number, limit: number) => {
      if ((tab.target.kind !== "local" && tab.target.kind !== "ssh") || tab.sessionId === undefined) return;
      try {
        const page =
          tab.target.kind === "ssh"
            ? await importSshHistory(tab.sessionId, offset, limit)
            : await importLocalHistory(tab.target.profileId, tab.shell ?? "", offset, limit);
        updateHistory(tab.id, (h) => withEarlier(h, page, offset === 0));
      } catch (e) {
        console.warn("history import", e);
      }
    },
    [updateHistory],
  );

  // Once a terminal is up, show the last few commands its shell ran before.
  // Again after a reconnect: the file may have grown.
  useEffect(() => {
    for (const tab of tabs) {
      if (tab.target.kind !== "local" && tab.target.kind !== "ssh") continue;
      if (tab.state !== "live" || tab.sessionId === undefined) continue;
      if (imported.current.get(tab.id) === tab.generation) continue;
      imported.current.set(tab.id, tab.generation);
      void loadEarlier(tab, 0, EARLIER_FIRST);
    }
  }, [tabs, loadEarlier]);

  useEffect(() => {
    listProfiles()
      .then(setProfiles)
      .catch((e) => console.error("local_profiles", e));
  }, []);

  const refreshServers = useCallback(async () => {
    try {
      const list = await listServers();
      setServers(list.servers);
      setConfigError(list.configError);
    } catch (e) {
      setConfigError(`Couldn't load servers: ${String(e)}`);
    }
  }, []);

  useEffect(() => {
    void refreshServers();
  }, [refreshServers]);

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const moveTab = useCallback((id: string, to: number) => {
    setTabs((list) => {
      const from = list.findIndex((t) => t.id === id);
      if (from < 0 || from === to) return list;
      const next = [...list];
      next.splice(to, 0, ...next.splice(from, 1));
      return next;
    });
  }, []);

  const openTab = useCallback((target: TabTarget) => {
    const tab = newTab(target);
    setTabs((list) => [...list, tab]);
    setActiveId(tab.id);
  }, []);

  const openLocal = useCallback(
    (profile?: LocalProfile) => {
      const chosen = profile ?? profiles[0];
      openTab({ kind: "local", profileId: chosen?.id ?? DEFAULT_PROFILE, name: chosen?.name });
    },
    [openTab, profiles],
  );

  const choose = useCallback(
    (choice: PaletteChoice) => {
      setPalette(false);
      setRecent((previous) => {
        const next = { ...previous, [choiceKey(choice)]: Date.now() };
        store("chappe.recent", next);
        return next;
      });
      if (choice.kind === "profile") openLocal(choice.profile);
      else if (choice.kind === "server") openTab({ kind: "ssh", serverId: choice.server.id, name: choice.server.name });
      else openTab({ kind: "ssh", serverId: choice.spec, name: choice.spec });
    },
    [openLocal, openTab],
  );

  /** Shows the settings tab, opening it if needed. */
  const openSettings = useCallback(() => {
    const existing = state.current.tabs.find((t) => t.target.kind === "settings");
    if (existing) setActiveId(existing.id);
    else openTab({ kind: "settings" });
  }, [openTab]);

  const openPalette = useCallback(() => {
    // ~/.ssh/config may have changed since the last look.
    void refreshServers();
    setPalette(true);
  }, [refreshServers]);

  const toggleFiles = useCallback(() => {
    setFilesVisible((visible: boolean) => {
      store("chappe.filesVisible", !visible);
      return !visible;
    });
  }, []);

  const toggleHistory = useCallback(() => {
    setHistoryVisible((visible: boolean) => {
      store("chappe.historyVisible", !visible);
      return !visible;
    });
  }, []);

  const removeTabs = useCallback((ids: string[]) => {
    const { tabs, activeId } = state.current;
    const gone = new Set(ids);
    if (!tabs.some((t) => gone.has(t.id))) return;
    for (const id of gone) {
      apis.current.delete(id);
      editors.current.delete(id);
      imported.current.delete(id);
    }
    setHistories((all) => Object.fromEntries(Object.entries(all).filter(([id]) => !gone.has(id))));
    setTabs(tabs.filter((t) => !gone.has(t.id)));
    if (activeId && gone.has(activeId)) {
      // The nearest tab left, to the right first, as browsers do.
      const index = tabs.findIndex((t) => t.id === activeId);
      const next =
        tabs.slice(index + 1).find((t) => !gone.has(t.id)) ??
        tabs
          .slice(0, index)
          .reverse()
          .find((t) => !gone.has(t.id));
      setActiveId(next?.id ?? null);
    }
  }, []);

  /** Closes tabs, asking first when editors among them have unsaved changes. */
  const closeTabs = useCallback(
    (ids: string[]) => {
      const dirty = state.current.tabs.filter((t) => ids.includes(t.id) && t.dirty);
      if (!dirty.length) return removeTabs(ids);
      if (dirty.length === 1) setActiveId(dirty[0].id);
      setClosing({ ids, dirty });
    },
    [removeTabs],
  );

  const closeTab = useCallback((id: string) => closeTabs([id]), [closeTabs]);

  /** Where an editor saves to, or why it can't right now. */
  const resolveTarget = useCallback((origin: FileOrigin): FsTarget | string => {
    if (origin.kind === "local") return { kind: "local" };
    const source = state.current.tabs.find((t) => t.id === origin.tabId);
    if (!source) return `The ${origin.serverName} session this file came from is closed. Open ${origin.serverName} again and reopen the file to save it.`;
    if (source.state !== "live" || source.sessionId === undefined) return `Reconnect ${origin.serverName} to save this file.`;
    return { kind: "ssh", sessionId: source.sessionId };
  }, []);

  /** Opens a file in an editor tab, or shows the tab it is already in. */
  const openEditor = useCallback(
    async (origin: FileOrigin, path: string, name: string) => {
      const existing = state.current.tabs.find(
        (t) => t.target.kind === "editor" && t.target.file.path === path && sameOrigin(t.target.file.origin, origin),
      );
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      const target = resolveTarget(origin);
      if (typeof target === "string") throw new Error(target);
      const initial = await readTextFile(target, path);
      openTab({ kind: "editor", file: { path, name, origin, initial } });
    },
    [openTab, resolveTarget],
  );

  const reconnect = useCallback((id: string) => {
    apis.current.delete(id);
    setTabs((list) =>
      list.map((t) =>
        t.id === id
          ? { ...t, generation: t.generation + 1, state: "connecting", title: "", sessionId: undefined, cwd: undefined }
          : t,
      ),
    );
  }, []);

  const run = useCallback(
    (action: Action) => {
      const { tabs, activeId } = state.current;
      const api = activeId ? apis.current.get(activeId) : undefined;
      const index = tabs.findIndex((t) => t.id === activeId);

      if (typeof action === "object") {
        const target = tabs[action.goto === 9 ? tabs.length - 1 : action.goto - 1];
        if (target) setActiveId(target.id);
        return;
      }
      switch (action) {
        case "new-session":
          return openPalette();
        case "toggle-files":
          return toggleFiles();
        case "toggle-history":
          return toggleHistory();
        case "settings":
          return openSettings();
        case "find":
          if (!activeId) return;
          return editors.current.get(activeId)?.find() ?? api?.find();
        case "close-tab":
          return activeId ? closeTab(activeId) : undefined;
        case "save":
          return activeId ? void editors.current.get(activeId)?.save() : undefined;
        case "next-tab":
        case "prev-tab": {
          if (tabs.length < 2) return;
          const step = action === "next-tab" ? 1 : -1;
          setActiveId(tabs[(index + step + tabs.length) % tabs.length].id);
          return;
        }
        case "copy":
          return void api?.copy();
        case "paste":
          return void api?.paste();
        case "select-all":
          return api?.selectAll();
      }
    },
    [openPalette, toggleFiles, toggleHistory, openSettings, closeTab],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const shortcut = matchShortcut(e);
      if (!shortcut || shortcut.native) return;
      // Text fields and the history list keep their own copy and paste.
      const clipboard = shortcut.action === "copy" || shortcut.action === "paste";
      if (clipboard && (isTextField(document.activeElement) || document.activeElement?.closest(".history-list"))) return;
      e.preventDefault();
      e.stopPropagation();
      run(shortcut.action);
    };
    window.addEventListener("keydown", onKeyDown, true);
    const unlisten = listen<string>("menu", (e) => {
      const focused = document.activeElement;
      if (e.payload === "select-all") {
        // The menu item would otherwise select the terminal from a text field.
        if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) return focused.select();
        if (focused?.closest(".files, .history")) return;
        const editor = state.current.activeId ? editors.current.get(state.current.activeId) : undefined;
        if (editor) return editor.selectAll();
      }
      if (e.payload === "close-tab" && focused?.closest(".modal, .prompt-card, .palette")) return;
      run(e.payload as Action);
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      void unlisten.then((off) => off());
    };
  }, [run]);

  // Quitting with unsaved files asks first.
  useEffect(() => {
    const window = getCurrentWindow();
    const unlisten = window.onCloseRequested((event) => {
      const unsaved = state.current.tabs.filter((t) => t.dirty).length;
      if (unsaved) {
        event.preventDefault();
        setQuitting(unsaved);
      }
    });
    return () => void unlisten.then((off) => off());
  }, []);

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  // An editor tab's files live where its source session is.
  const activeOrigin = activeTab?.target.kind === "editor" ? activeTab.target.file.origin : null;
  const sourceTab = activeOrigin?.kind === "ssh" ? (tabs.find((t) => t.id === activeOrigin.tabId) ?? null) : null;
  const overlay = Boolean(dialog || palette || closing || quitting || updateOpen);

  return (
    <div
      className="app"
      data-files={filesVisible ? "shown" : "hidden"}
      style={{
        gridTemplateColumns: [filesVisible && `${width}px`, "minmax(0, 1fr)", historyVisible && `${historyShown}px`]
          .filter(Boolean)
          .join(" "),
      }}
    >
      {filesVisible && (
        <>
          <FilePanel
            tab={activeTab?.target.kind === "settings" ? null : activeTab}
            sourceTab={sourceTab}
            onEdit={openEditor}
            refreshKey={filesVersion}
            sendToTerminal={(text) => {
              // From an editor tab, "Open in terminal" goes to its source session.
              const id = sourceTab?.id ?? activeId;
              if (!id) return;
              apis.current.get(id)?.sendText(text);
              setActiveId(id);
            }}
          />
          <Splitter
            width={width}
            min={SIDEBAR_MIN}
            max={sidebarMax}
            defaultWidth={SIDEBAR_DEFAULT}
            label="Resize the files panel"
            onChange={setSidebarWidth}
            onCommit={(w) => store("chappe.sidebarWidth", String(w))}
          />
        </>
      )}
      <main className="main">
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={setActiveId}
          onClose={closeTab}
          onCloseMany={closeTabs}
          onMove={moveTab}
          onNew={openPalette}
        />
        <div className="terminals">
          {/* Panes stay in creation order: reordering tabs must not move a
              pane in the DOM, which would drop its focus and scroll position. */}
          {[...tabs].sort(byCreation).map((tab) =>
            tab.target.kind === "editor" ? (
              <CodeEditor
                key={tab.id}
                file={tab.target.file}
                settings={settings}
                active={tab.id === activeId}
                focused={!overlay}
                resolveTarget={() => resolveTarget((tab.target as { file: EditorFile }).file.origin)}
                onReady={(api) => editors.current.set(tab.id, api)}
                onDirty={(dirty) => patchTab(tab.id, { dirty })}
                onCursor={(line, col) => patchTab(tab.id, { cursor: { line, col } })}
                onInfo={(info) => patchTab(tab.id, { ...info, state: "live" })}
                onSaved={() => setFilesVersion((v) => v + 1)}
              />
            ) : tab.target.kind === "settings" ? (
              <SettingsPage
                key={tab.id}
                active={tab.id === activeId}
                settings={settings}
                onChange={updateSettings}
                onReset={() => updateSettings(DEFAULT_SETTINGS)}
                updates={{
                  version,
                  configured: canUpdate,
                  available: update,
                  check: async () => {
                    const found = await checkForUpdate();
                    setUpdate(found);
                    return found;
                  },
                  open: () => setUpdateOpen(true),
                }}
              />
            ) : (
            <TerminalView
              key={`${tab.id}:${tab.generation}`}
              target={tab.target}
              settings={settings}
              active={tab.id === activeId}
              focused={!overlay}
              onReady={(api) => apis.current.set(tab.id, api)}
              onInfo={({ shell, address, sessionId }) => patchTab(tab.id, { shell, address, sessionId })}
              onCwd={(cwd) => patchTab(tab.id, { cwd })}
              onState={(state) => {
                patchTab(tab.id, { state });
                // A password may just have been remembered.
                if (state === "live" && tab.target.kind === "ssh") void refreshServers();
              }}
              onTitle={(title) => patchTab(tab.id, { title })}
              onCommand={(command) => recordCommand(tab, command)}
              onSize={(cols, rows) => patchTab(tab.id, { cols, rows })}
              onEnd={(info) => {
                // A clean `exit` closes the tab, like Terminal.app. Anything
                // else stays open so the message can be read.
                const clean = info.code === 0 && !info.signal && !info.error;
                if (clean) closeTab(tab.id);
                return clean;
              }}
              onReconnect={() => reconnect(tab.id)}
              onClose={() => closeTab(tab.id)}
            />
            ),
          )}
          {tabs.length === 0 && <EmptyState onNew={openPalette} />}
          {palette && (
            <SessionPalette
              profiles={profiles}
              servers={servers}
              recent={recent}
              onChoose={choose}
              onAddServer={() => {
                setPalette(false);
                setDialog({ server: null });
              }}
              onEditServer={(server) => {
                setPalette(false);
                setDialog({ server });
              }}
              onClose={() => setPalette(false)}
            />
          )}
        </div>
        <StatusBar
          tab={activeTab}
          filesVisible={filesVisible}
          onToggleFiles={toggleFiles}
          historyVisible={historyVisible}
          onToggleHistory={toggleHistory}
          onOpenSettings={openSettings}
          updateVersion={update?.version}
          onOpenUpdate={() => setUpdateOpen(true)}
          configError={configError}
        />
      </main>
      {historyVisible && (
        <>
          <Splitter
            width={historyShown}
            min={HISTORY_MIN}
            max={historyMax}
            defaultWidth={HISTORY_DEFAULT}
            side="right"
            label="Resize the history panel"
            onChange={setHistoryWidth}
            onCommit={(w) => store("chappe.historyWidth", String(w))}
          />
          <HistoryPanel
            label={terminalLabel(activeTab)}
            history={activeTab ? (histories[activeTab.id] ?? emptyHistory) : null}
            unavailable={
              !activeTab || (activeTab.target.kind !== "local" && activeTab.target.kind !== "ssh")
                ? "Switch to a terminal tab to use a command."
                : activeTab.state !== "live"
                  ? "This terminal isn't connected."
                  : null
            }
            onInsert={(command) => activeId && apis.current.get(activeId)?.insert(command)}
            onRun={(command) => {
              const api = activeId ? apis.current.get(activeId) : undefined;
              if (!api) return "This terminal isn't ready yet.";
              const busy = api.run(command);
              return busy ? busyText[busy] : null;
            }}
            onRemove={(command) =>
              activeId &&
              updateHistory(activeId, (h) => ({
                ...h,
                session: h.session.filter((c) => c.command !== command),
                earlier: h.earlier.filter((c) => c !== command),
              }))
            }
            onLoadMore={async () => {
              if (!activeTab) return;
              const fetched = histories[activeTab.id]?.fetched ?? 0;
              await loadEarlier(activeTab, fetched, EARLIER_MORE);
            }}
            onClear={() => activeId && updateHistory(activeId, () => emptyHistory)}
            onClose={toggleHistory}
          />
        </>
      )}

      {closing && (
        <ConfirmDialog
          title={
            closing.dirty.length === 1
              ? `Save changes to ${fileName(closing.dirty[0])}?`
              : `Save changes to ${closing.dirty.length} files?`
          }
          body={
            closing.dirty.length === 1
              ? "Your changes will be lost if you don't save them."
              : `${closing.dirty.map(fileName).join(", ")}. Your changes will be lost if you don't save them.`
          }
          confirm={closing.dirty.length === 1 ? "Save" : "Save all"}
          alternative={{
            label: "Don't save",
            onSelect: () => {
              setClosing(null);
              removeTabs(closing.ids);
            },
          }}
          onCancel={() => setClosing(null)}
          onConfirm={async () => {
            const { ids, dirty } = closing;
            setClosing(null);
            // A file that can't be saved (a conflict, a lost connection)
            // keeps its tab open, and is shown.
            const failed: string[] = [];
            for (const tab of dirty) {
              if (!(await editors.current.get(tab.id)?.save())) failed.push(tab.id);
            }
            removeTabs(ids.filter((id) => !failed.includes(id)));
            if (failed.length) setActiveId(failed[0]);
          }}
        />
      )}
      {quitting > 0 && (
        <ConfirmDialog
          title={quitting === 1 ? "Quit with an unsaved file?" : `Quit with ${quitting} unsaved files?`}
          body="Changes you haven't saved will be lost."
          confirm="Quit"
          danger
          onCancel={() => setQuitting(0)}
          onConfirm={() => void getCurrentWindow().destroy()}
        />
      )}
      {updateOpen && update && (
        <UpdateDialog
          update={update}
          unsaved={tabs.filter((t) => t.dirty).length}
          onClose={() => setUpdateOpen(false)}
        />
      )}
      {dialog && (
        <ServerDialog
          server={dialog.server}
          servers={servers}
          onCancel={() => setDialog(null)}
          onDone={(saved) => {
            setDialog(null);
            void refreshServers();
            if (saved) {
              // Open tabs keep their name in sync with the server.
              setTabs((list) =>
                list.map((t) =>
                  t.target.kind === "ssh" && t.target.serverId === saved.id
                    ? { ...t, target: { ...t.target, name: saved.name } }
                    : t,
                ),
              );
            }
          }}
        />
      )}
    </div>
  );
}
