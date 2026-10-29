import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_THEME, THEMES } from "./themes";
import { isMac } from "./platform";

export type CursorStyle = "bar" | "block" | "underline";

export interface Settings {
  theme: string;
  /** A font family name, or "" for the automatic choice. */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: CursorStyle;
  /** New terminals only: xterm.js can't change it on a live WebGL terminal. */
  cursorBlink: boolean;
  scrollback: number;
  editorFontSize: number;
  /** "" for Barlow Semi Condensed, "system" for the system's own, or a family name. */
  uiFontFamily: string;
  /** Interface text size, as a factor of the default. */
  uiScale: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: DEFAULT_THEME,
  fontFamily: "",
  fontSize: 13,
  lineHeight: 1.2,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10_000,
  editorFontSize: 13,
  uiFontFamily: "",
  uiScale: 1,
};

export const FONT_SIZES = { min: 8, max: 32 };
export const LINE_HEIGHTS = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];
export const SCROLLBACKS = [1_000, 5_000, 10_000, 50_000, 100_000];
export const UI_SCALES = [
  { value: 0.9, label: "Small" },
  { value: 1, label: "Default" },
  { value: 1.1, label: "Large" },
  { value: 1.2, label: "Larger" },
];

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;

/** Settings from disk, made safe: unknown or broken values fall back to defaults. */
export function normalize(raw: unknown): Settings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const d = DEFAULT_SETTINGS;
  return {
    theme: typeof s.theme === "string" && THEMES.some((t) => t.id === s.theme) ? s.theme : d.theme,
    fontFamily: typeof s.fontFamily === "string" ? s.fontFamily.trim().slice(0, 100) : d.fontFamily,
    fontSize: clamp(s.fontSize, FONT_SIZES.min, FONT_SIZES.max, d.fontSize),
    lineHeight:
      typeof s.lineHeight === "number" && s.lineHeight >= 1 && s.lineHeight <= 2 ? s.lineHeight : d.lineHeight,
    cursorStyle: s.cursorStyle === "block" || s.cursorStyle === "underline" ? s.cursorStyle : "bar",
    cursorBlink: typeof s.cursorBlink === "boolean" ? s.cursorBlink : d.cursorBlink,
    scrollback: clamp(s.scrollback, 100, 1_000_000, d.scrollback),
    editorFontSize: clamp(s.editorFontSize, FONT_SIZES.min, FONT_SIZES.max, d.editorFontSize),
    uiFontFamily: typeof s.uiFontFamily === "string" ? s.uiFontFamily.trim().slice(0, 100) : d.uiFontFamily,
    uiScale: UI_SCALES.some((u) => u.value === s.uiScale) ? (s.uiScale as number) : d.uiScale,
  };
}

export async function loadSettings(): Promise<Settings> {
  try {
    return normalize(await invoke<unknown>("settings_load"));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const saveSettings = (settings: Settings) => invoke<void>("settings_save", { settings });

// ---------- Fonts ----------

/** Shipped with the app, so always there. */
export const BUNDLED_FONTS = ["JetBrains Mono", "Fira Code", "Source Code Pro", "IBM Plex Mono"];

/** Common monospace fonts, offered when installed. */
const KNOWN_FONTS = [
  "SF Mono",
  "Menlo",
  "Monaco",
  "Cascadia Code",
  "Cascadia Mono",
  "Consolas",
  "Lucida Console",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Liberation Mono",
  "Noto Sans Mono",
  "Hack",
  "Inconsolata",
  "Iosevka",
  "Roboto Mono",
  "Victor Mono",
  "Fantasque Sans Mono",
  "Monaspace Neon",
  "Berkeley Mono",
  "Operator Mono",
  "Input Mono",
  "PragmataPro",
  "Courier New",
  "MesloLGS NF",
  "MesloLGS Nerd Font",
  "JetBrainsMono Nerd Font",
  "FiraCode Nerd Font",
  "Hack Nerd Font",
  "CaskaydiaCove Nerd Font",
];

/** Installed Nerd Fonts come next, so prompt icons (powerlevel10k) still show. */
const NERD_FALLBACKS = [
  "MesloLGS NF",
  "MesloLGS Nerd Font",
  "JetBrainsMono Nerd Font",
  "Hack Nerd Font",
  "FiraCode Nerd Font",
];

const quote = (family: string) => `"${family.replace(/["\\]/g, "")}"`;

/** The CSS font stack for a chosen family. */
export function fontStack(family: string): string {
  const first = family ? [quote(family)] : [];
  const rest = [...NERD_FALLBACKS.filter((f) => f !== family).map(quote), quote("JetBrains Mono")];
  return [...first, ...rest, isMac ? "Menlo" : "", "monospace"].filter(Boolean).join(", ");
}

let probe: CanvasRenderingContext2D | null = null;

/**
 * Whether a font is installed. A canvas draws the same text with the font
 * and with generic fallbacks: a different width means the font was used.
 */
export function fontInstalled(family: string): boolean {
  probe ??= document.createElement("canvas").getContext("2d");
  if (!probe) return false;
  const text = "mmmmmmmmmlli1|WW@#0Oo";
  return ["monospace", "serif", "sans-serif"].some((generic) => {
    probe!.font = `72px ${generic}`;
    const base = probe!.measureText(text).width;
    probe!.font = `72px ${quote(family)}, ${generic}`;
    return probe!.measureText(text).width !== base;
  });
}

export function installedFonts(): string[] {
  return KNOWN_FONTS.filter((f) => !BUNDLED_FONTS.includes(f) && fontInstalled(f));
}

// ---------- Interface fonts ----------

export const BUNDLED_UI_FONTS = ["Barlow Semi Condensed", "Inter"];

const KNOWN_UI_FONTS = [
  "Helvetica Neue",
  "Avenir Next",
  "Segoe UI",
  "Ubuntu",
  "Cantarell",
  "Noto Sans",
  "Roboto",
  "Open Sans",
  "Lato",
  "Source Sans 3",
  "IBM Plex Sans",
  "Fira Sans",
  "DejaVu Sans",
  "Liberation Sans",
  "Arial",
];

export function installedUiFonts(): string[] {
  return KNOWN_UI_FONTS.filter((f) => fontInstalled(f));
}

const SYSTEM_UI = 'system-ui, -apple-system, "Segoe UI", Ubuntu, Cantarell, sans-serif';

export function uiFontStack(family: string): string {
  if (family === "") return `"Barlow Semi Condensed", ${SYSTEM_UI}`;
  if (family === "system") return SYSTEM_UI;
  return `${quote(family)}, ${SYSTEM_UI}`;
}

/**
 * Interface fonts and text size, as CSS variables. Monospace bits of the
 * interface (paths, sizes, commands) use the terminal's font.
 */
export function applyInterface(settings: Settings) {
  const root = document.documentElement.style;
  root.setProperty("--font-ui", uiFontStack(settings.uiFontFamily));
  root.setProperty("--font-mono", fontStack(settings.fontFamily));
  root.setProperty("--ui-scale", String(settings.uiScale));
}

/** Waits for the fonts a stack needs, so the terminal measures the right one. */
export async function loadFont(family: string, size: number): Promise<void> {
  const name = family || "JetBrains Mono";
  try {
    await Promise.all([document.fonts.load(`${size}px ${quote(name)}`), document.fonts.load(`bold ${size}px ${quote(name)}`)]);
  } catch {
    // Measuring a fallback font is better than not starting at all.
  }
}

