import { isMac } from "./platform";

export type Action =
  | "new-session"
  | "toggle-files"
  | "toggle-history"
  | "settings"
  | "find"
  | "save"
  | "close-tab"
  | "next-tab"
  | "prev-tab"
  | "copy"
  | "paste"
  | "select-all"
  | { goto: number };

export interface Shortcut {
  action: Action;
  /**
   * Owned by the native menu (macOS): the frontend must neither handle it
   * nor prevent its default, or the menu item would not fire.
   */
  native: boolean;
}

/** Maps a key press to an app action, or null if it belongs to the shell. */
export function matchShortcut(e: KeyboardEvent): Shortcut | null {
  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
    return { action: e.shiftKey ? "prev-tab" : "next-tab", native: false };
  }

  if (isMac) {
    if (!e.metaKey || e.ctrlKey || e.altKey) return null;
    const native = (action: Action): Shortcut => ({ action, native: true });
    if (e.shiftKey) {
      if (e.code === "BracketRight") return native("next-tab");
      if (e.code === "BracketLeft") return native("prev-tab");
      if (e.code === "KeyH") return native("toggle-history");
      return null;
    }
    switch (e.code) {
      case "Comma":
        return native("settings");
      case "KeyF":
        return native("find");
      case "KeyT":
        return native("new-session");
      case "KeyB":
        return native("toggle-files");
      case "KeyW":
        return native("close-tab");
      case "KeyC":
        return native("copy");
      case "KeyV":
        return native("paste");
      case "KeyA":
        return native("select-all");
    }
    const digit = /^Digit([1-9])$/.exec(e.code);
    if (digit) return { action: { goto: Number(digit[1]) }, native: false };
    return null;
  }

  // Windows and Linux: Ctrl+<key> belongs to the shell, so app shortcuts
  // take Ctrl+Shift, like GNOME Terminal and Windows Terminal.
  if (e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === "PageDown") return { action: "next-tab", native: false };
    if (e.key === "PageUp") return { action: "prev-tab", native: false };
    // Ctrl+, opens settings, as in most editors; shells have no use for it.
    if (!e.shiftKey) return e.code === "Comma" ? { action: "settings", native: false } : null;
    switch (e.code) {
      case "KeyT":
        return { action: "new-session", native: false };
      case "KeyB":
        return { action: "toggle-files", native: false };
      case "KeyH":
        return { action: "toggle-history", native: false };
      case "KeyF":
        return { action: "find", native: false };
      case "KeyW":
        return { action: "close-tab", native: false };
      case "KeyC":
        return { action: "copy", native: false };
      case "KeyV":
        return { action: "paste", native: false };
    }
  }
  return null;
}

export const shortcutLabel = {
  newSession: isMac ? "⌘T" : "Ctrl+Shift+T",
  toggleFiles: isMac ? "⌘B" : "Ctrl+Shift+B",
  toggleHistory: isMac ? "⇧⌘H" : "Ctrl+Shift+H",
  settings: isMac ? "⌘," : "Ctrl+,",
  find: isMac ? "⌘F" : "Ctrl+Shift+F",
  closeTab: isMac ? "⌘W" : "Ctrl+Shift+W",
};
