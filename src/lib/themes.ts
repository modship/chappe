import type { ITheme } from "@xterm/xterm";

/** The 16 ANSI colours plus the terminal's own. */
export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  /** Text under a block cursor. Defaults to the background. */
  cursorAccent?: string;
  /** Defaults to the blue, see-through. */
  selection?: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  id: string;
  name: string;
  light: boolean;
  /** The one colour that stands out: active tab, focus, buttons. */
  accent: string;
  colors: TerminalColors;
  /** Interface colours set by hand rather than derived. */
  ui?: Partial<UiColors>;
}

/** CSS custom properties of the interface, without the leading "--". */
export interface UiColors {
  "term-bg": string;
  chrome: string;
  raised: string;
  hover: string;
  line: string;
  ink: string;
  "ink-muted": string;
  "ink-faint": string;
  "ink-soft": string;
  signal: string;
  "signal-hover": string;
  "signal-tint": string;
  "on-signal": string;
  verdigris: string;
  danger: string;
  "danger-hover": string;
  "danger-tint": string;
  "on-danger": string;
  "selected-strong": string;
  "focus-ring": string;
  folder: string;
  menu: string;
  "button-hover": string;
  scrim: string;
  "scrim-strong": string;
  "term-scrim": string;
  shadow: string;
  "shadow-strong": string;
}

export const THEMES: Theme[] = [
  {
    id: "chappe-dark",
    name: "Chappe Dark",
    light: false,
    accent: "#e8b931",
    colors: {
      background: "#12161f",
      foreground: "#dce1ea",
      cursor: "#e8b931",
      black: "#1e2430",
      red: "#e5786d",
      green: "#8cc085",
      yellow: "#e8b931",
      blue: "#6fa3e0",
      magenta: "#c38fd8",
      cyan: "#5fb8ae",
      white: "#c9cfda",
      brightBlack: "#5a6478",
      brightRed: "#f0928a",
      brightGreen: "#a6d49f",
      brightYellow: "#f3cc5c",
      brightBlue: "#8fbaee",
      brightMagenta: "#d3a8e4",
      brightCyan: "#7fccc3",
      brightWhite: "#f2f4f8",
    },
    // The original hand-picked slate.
    ui: {
      chrome: "#191e29",
      raised: "#222936",
      hover: "#1f2531",
      line: "#2a3242",
      "ink-muted": "#8590a5",
      "ink-faint": "#5a6478",
      verdigris: "#5fa89a",
      "selected-strong": "#2c3a52",
      folder: "#7d8cab",
      menu: "#1f2532",
      "button-hover": "#2b3343",
    },
  },
  {
    id: "chappe-light",
    name: "Chappe Light",
    light: true,
    accent: "#b8860b",
    colors: {
      background: "#fbfaf7",
      foreground: "#262b36",
      cursor: "#b8860b",
      black: "#262b36",
      red: "#c4473a",
      green: "#3d8a4a",
      yellow: "#9a6d00",
      blue: "#2f6cb5",
      magenta: "#9a4fb5",
      cyan: "#1f8a80",
      white: "#c9c6bf",
      brightBlack: "#7a8090",
      brightRed: "#d9584b",
      brightGreen: "#4f9e5c",
      brightYellow: "#b88400",
      brightBlue: "#4482cc",
      brightMagenta: "#b064cc",
      brightCyan: "#2a9d92",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    light: false,
    accent: "#b58900",
    colors: {
      background: "#002b36",
      foreground: "#93a1a1",
      cursor: "#93a1a1",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#586e75",
      brightRed: "#cb4b16",
      brightGreen: "#859900",
      brightYellow: "#b58900",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  {
    id: "solarized-light",
    name: "Solarized Light",
    light: true,
    accent: "#b58900",
    colors: {
      background: "#fdf6e3",
      foreground: "#586e75",
      cursor: "#586e75",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#93a1a1",
      brightBlack: "#93a1a1",
      brightRed: "#cb4b16",
      brightGreen: "#859900",
      brightYellow: "#b58900",
      brightBlue: "#657b83",
      brightMagenta: "#6c71c4",
      brightCyan: "#2aa198",
      brightWhite: "#073642",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    light: false,
    accent: "#bd93f9",
    colors: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selection: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "nord",
    name: "Nord",
    light: false,
    accent: "#88c0d0",
    colors: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#616e88",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  {
    id: "gruvbox-dark",
    name: "Gruvbox Dark",
    light: false,
    accent: "#fabd2f",
    colors: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      black: "#3c3836",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
  },
  {
    id: "one-dark",
    name: "One Dark",
    light: false,
    accent: "#61afef",
    colors: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      black: "#3f4451",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#d7dae0",
      brightBlack: "#5c6370",
      brightRed: "#f07c86",
      brightGreen: "#a8d38a",
      brightYellow: "#f0d08c",
      brightBlue: "#74bcf5",
      brightMagenta: "#d28ae6",
      brightCyan: "#68c6d1",
      brightWhite: "#ffffff",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    light: false,
    accent: "#7aa2f7",
    colors: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#565f89",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    light: false,
    accent: "#cba6f7",
    colors: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    light: true,
    accent: "#8839ef",
    colors: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#dc8a78",
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#ea76cb",
      cyan: "#179299",
      white: "#acb0be",
      brightBlack: "#6c6f85",
      brightRed: "#d20f39",
      brightGreen: "#40a02b",
      brightYellow: "#df8e1d",
      brightBlue: "#1e66f5",
      brightMagenta: "#ea76cb",
      brightCyan: "#179299",
      brightWhite: "#bcc0cc",
    },
  },
];

export const DEFAULT_THEME = "chappe-dark";

export const themeById = (id: string) => THEMES.find((t) => t.id === id) ?? THEMES[0];

// ---------- Colour arithmetic ----------

function rgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (c: number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** `amount` of the way from `a` to `b`. */
export function mix(a: string, b: string, amount: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return toHex(x.map((v, i) => v + (y[i] - v) * amount));
}

/** A colour with an alpha byte, "#rrggbbaa". */
export const alpha = (color: string, a: number) =>
  `${mix(color, color, 0)}${Math.round(a * 255)
    .toString(16)
    .padStart(2, "0")}`;

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Dark or white text, whichever reads better on `background`. */
const textOn = (background: string) => (luminance(background) > 0.3 ? mix(background, "#000000", 0.88) : "#ffffff");

// ---------- Derived colours ----------

export function uiColors(theme: Theme): UiColors {
  const { background: bg, foreground: fg } = theme.colors;
  const c = theme.colors;
  const toward = (amount: number) => mix(bg, fg, amount);
  const derived: UiColors = {
    "term-bg": bg,
    chrome: toward(0.04),
    raised: toward(0.085),
    hover: toward(0.06),
    line: toward(theme.light ? 0.14 : 0.12),
    ink: fg,
    "ink-muted": toward(theme.light ? 0.66 : 0.58),
    "ink-faint": toward(theme.light ? 0.46 : 0.38),
    "ink-soft": toward(0.82),
    signal: theme.accent,
    "signal-hover": mix(theme.accent, theme.light ? "#000000" : "#ffffff", 0.14),
    "signal-tint": alpha(theme.accent, 0.06),
    "on-signal": textOn(theme.accent),
    verdigris: c.green,
    danger: c.red,
    "danger-hover": c.brightRed,
    "danger-tint": alpha(c.red, 0.12),
    "on-danger": textOn(c.red),
    "selected-strong": mix(bg, c.blue, theme.light ? 0.16 : 0.24),
    "focus-ring": alpha(c.blue, 0.4),
    folder: mix(toward(0.55), c.blue, 0.35),
    menu: theme.light ? mix(bg, "#ffffff", 0.7) : toward(0.07),
    "button-hover": toward(0.12),
    scrim: theme.light ? alpha("#000000", 0.18) : alpha(mix(bg, "#000000", 0.4), 0.4),
    "scrim-strong": theme.light ? alpha("#000000", 0.3) : alpha(mix(bg, "#000000", 0.4), 0.6),
    "term-scrim": alpha(bg, 0.8),
    shadow: theme.light ? alpha("#000000", 0.16) : alpha("#000000", 0.55),
    "shadow-strong": theme.light ? alpha("#000000", 0.22) : alpha("#000000", 0.65),
  };
  return { ...derived, ...theme.ui };
}

/** The terminal's colours, as xterm.js wants them. */
export function xtermTheme(theme: Theme): ITheme {
  const { selection, ...colors } = theme.colors;
  const fg = colors.foreground;
  return {
    ...colors,
    cursorAccent: colors.cursorAccent ?? colors.background,
    selectionBackground: selection ?? alpha(colors.blue, theme.light ? 0.25 : 0.3),
    selectionInactiveBackground: alpha(selection ?? colors.blue, 0.15),
    scrollbarSliderBackground: alpha(fg, 0.12),
    scrollbarSliderHoverBackground: alpha(fg, 0.2),
    scrollbarSliderActiveBackground: alpha(fg, 0.3),
  };
}

/** Sets the interface colours on the page. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  for (const [name, value] of Object.entries(uiColors(theme))) root.style.setProperty(`--${name}`, value);
  root.style.colorScheme = theme.light ? "light" : "dark";
  root.dataset.theme = theme.light ? "light" : "dark";
}
