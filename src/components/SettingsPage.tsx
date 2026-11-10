import { useEffect, useMemo, useState } from "react";
import {
  BUNDLED_FONTS,
  BUNDLED_UI_FONTS,
  FONT_SIZES,
  UI_SCALES,
  installedUiFonts,
  LINE_HEIGHTS,
  SCROLLBACKS,
  fontInstalled,
  fontStack,
  installedFonts,
  loadFont,
  type CursorStyle,
  type Settings,
} from "../lib/settings";
import { THEMES, themeById, type Theme } from "../lib/themes";
import { updateError, type Update } from "../lib/updates";

interface Props {
  active: boolean;
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
  onReset(): void;
  updates: Updates;
}

interface Updates {
  version: string;
  /** This build can verify updates (it has a public key). */
  configured: boolean;
  /** A newer version found by a check. */
  available: Update | null;
  check(): Promise<Update | null>;
  /** Shows what's new and offers to install. */
  open(): void;
}

const OTHER = "\u0000other";

export function SettingsPage({ active, settings, onChange, onReset, updates }: Props) {
  const theme = themeById(settings.theme);
  // Listing installed fonts measures text; once is enough.
  const installed = useMemo(() => installedFonts(), []);
  const installedUi = useMemo(() => installedUiFonts(), []);
  /** Bumped by "Reset", so the font pickers forget a custom name. */
  const [generation, setGeneration] = useState(0);

  // The preview uses the chosen font; bundled fonts load on demand.
  const [, setFontsLoaded] = useState(0);
  useEffect(() => {
    void loadFont(settings.fontFamily, settings.fontSize).then(() => setFontsLoaded((n) => n + 1));
  }, [settings.fontFamily, settings.fontSize]);

  return (
    <div className="term-pane settings-pane" data-active={active}>
      <div className="settings">
        <header className="settings-header">
          <h1>Settings</h1>
          <p>Changes apply right away and are saved automatically.</p>
        </header>

        <section className="settings-section" aria-labelledby="settings-theme">
          <h2 id="settings-theme">Theme</h2>
          <div className="theme-grid" role="radiogroup" aria-labelledby="settings-theme">
            {THEMES.map((t) => (
              <ThemeCard key={t.id} theme={t} selected={t.id === settings.theme} onSelect={() => onChange({ theme: t.id })} />
            ))}
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-interface">
          <h2 id="settings-interface">Interface</h2>
          <div className="settings-row">
            <label htmlFor="settings-ui-font">Font</label>
            <div className="settings-control">
              <FontPicker
                key={generation}
                id="settings-ui-font"
                value={settings.uiFontFamily}
                defaults={[
                  { value: "", label: "Barlow Semi Condensed (default)" },
                  { value: "system", label: "System font" },
                ]}
                bundled={BUNDLED_UI_FONTS.filter((f) => f !== "Barlow Semi Condensed")}
                installed={installedUi}
                onChange={(uiFontFamily) => onChange({ uiFontFamily })}
              />
              <p className="settings-hint">
                Tabs, panels, menus and dialogs. Paths and commands use the terminal font.
              </p>
            </div>
          </div>
          <div className="settings-row">
            <span id="settings-ui-scale">Text size</span>
            <div className="settings-control">
              <div className="segmented settings-segmented-wide" role="radiogroup" aria-labelledby="settings-ui-scale">
                {UI_SCALES.map((scale) => (
                  <button
                    key={scale.value}
                    type="button"
                    className="segment"
                    role="radio"
                    aria-checked={settings.uiScale === scale.value}
                    onClick={() => onChange({ uiScale: scale.value })}
                  >
                    {scale.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-terminal">
          <h2 id="settings-terminal">Terminal</h2>

          <div className="settings-row">
            <label htmlFor="settings-font">Font</label>
            <div className="settings-control">
              <FontPicker
                key={generation}
                id="settings-font"
                value={settings.fontFamily}
                defaults={[{ value: "", label: "Automatic" }]}
                bundled={BUNDLED_FONTS}
                installed={installed}
                onChange={(fontFamily) => onChange({ fontFamily })}
              />
              <p className="settings-hint">
                {settings.fontFamily === ""
                  ? "A Nerd Font if one is installed, so prompt icons show; JetBrains Mono otherwise."
                  : "Installed Nerd Fonts fill in the icons this font lacks."}
              </p>
            </div>
          </div>

          <div className="settings-row">
            <label htmlFor="settings-size">Font size</label>
            <div className="settings-control">
              <Stepper id="settings-size" value={settings.fontSize} onChange={(fontSize) => onChange({ fontSize })} />
            </div>
          </div>

          <div className="settings-row">
            <label htmlFor="settings-line">Line height</label>
            <div className="settings-control">
              <select
                id="settings-line"
                className="settings-select settings-select-short"
                value={settings.lineHeight}
                onChange={(e) => onChange({ lineHeight: Number(e.target.value) })}
              >
                {LINE_HEIGHTS.map((h) => (
                  <option key={h} value={h}>
                    {h.toFixed(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="settings-row">
            <span id="settings-cursor">Cursor</span>
            <div className="settings-control">
              <div className="segmented" role="radiogroup" aria-labelledby="settings-cursor">
                {(["bar", "block", "underline"] as CursorStyle[]).map((style) => (
                  <button
                    key={style}
                    type="button"
                    className="segment"
                    role="radio"
                    aria-checked={settings.cursorStyle === style}
                    onClick={() => onChange({ cursorStyle: style })}
                  >
                    {style[0].toUpperCase() + style.slice(1)}
                  </button>
                ))}
              </div>
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={settings.cursorBlink}
                  onChange={(e) => onChange({ cursorBlink: e.target.checked })}
                />
                Blinking cursor
                <span className="settings-hint-inline">new tabs</span>
              </label>
            </div>
          </div>

          <div className="settings-row">
            <label htmlFor="settings-scrollback">Scrollback</label>
            <div className="settings-control">
              <select
                id="settings-scrollback"
                className="settings-select settings-select-short"
                value={settings.scrollback}
                onChange={(e) => onChange({ scrollback: Number(e.target.value) })}
              >
                {[...new Set([...SCROLLBACKS, settings.scrollback])]
                  .sort((a, b) => a - b)
                  .map((n) => (
                    <option key={n} value={n}>
                      {n.toLocaleString("en")} lines
                    </option>
                  ))}
              </select>
            </div>
          </div>

          <Preview theme={theme} settings={settings} />
        </section>

        <section className="settings-section" aria-labelledby="settings-editor">
          <h2 id="settings-editor">Editor</h2>
          <div className="settings-row">
            <label htmlFor="settings-editor-size">Font size</label>
            <div className="settings-control">
              <Stepper
                id="settings-editor-size"
                value={settings.editorFontSize}
                onChange={(editorFontSize) => onChange({ editorFontSize })}
              />
              <p className="settings-hint">The editor uses the terminal's font and theme.</p>
            </div>
          </div>
        </section>

        <UpdatesSection updates={updates} settings={settings} onChange={onChange} />

        <footer className="settings-footer">
          <button
            type="button"
            className="button-quiet"
            onClick={() => {
              setGeneration((n) => n + 1);
              onReset();
            }}
          >
            Reset to defaults
          </button>
        </footer>
      </div>
    </div>
  );
}

function UpdatesSection({
  updates,
  settings,
  onChange,
}: {
  updates: Updates;
  settings: Settings;
  onChange(patch: Partial<Settings>): void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);

  const check = () => {
    setChecking(true);
    setResult(null);
    updates
      .check()
      .then((found) => {
        if (found) updates.open();
        else setResult({ text: "Chappe is up to date.", error: false });
      })
      .catch((e) => setResult({ text: updateError(e), error: true }))
      .finally(() => setChecking(false));
  };

  return (
    <section className="settings-section" aria-labelledby="settings-updates">
      <h2 id="settings-updates">Updates</h2>
      <div className="settings-row">
        <span>Version</span>
        <div className="settings-control">
          <span className="settings-version">{updates.version || "…"}</span>
          {updates.available ? (
            <button type="button" className="button-primary button-small" onClick={updates.open}>
              Install {updates.available.version}…
            </button>
          ) : (
            <button
              type="button"
              className="button-quiet button-small"
              disabled={!updates.configured || checking}
              onClick={check}
            >
              {checking ? "Checking…" : "Check for updates"}
            </button>
          )}
          {result && (
            <p className={result.error ? "settings-hint settings-warning" : "settings-hint"} role="status">
              {result.text}
            </p>
          )}
          {!updates.configured && (
            <p className="settings-hint">
              This build has no update signing key, so it can't verify updates. See "Releases and updates" in
              DEVELOPMENT.md.
            </p>
          )}
        </div>
      </div>
      <div className="settings-row">
        <span />
        <div className="settings-control">
          <label className="settings-check">
            <input
              type="checkbox"
              checked={settings.autoUpdateCheck}
              disabled={!updates.configured}
              onChange={(e) => onChange({ autoUpdateCheck: e.target.checked })}
            />
            Check for updates automatically
          </label>
        </div>
      </div>
    </section>
  );
}

interface FontPickerProps {
  id: string;
  value: string;
  /** Choices listed first, such as "Automatic". */
  defaults: { value: string; label: string }[];
  bundled: string[];
  installed: string[];
  onChange(family: string): void;
}

/** A font list, with any installed font as a last resort. */
function FontPicker({ id, value, defaults, bundled, installed, onChange }: FontPickerProps) {
  const known = defaults.some((d) => d.value === value) || bundled.includes(value) || installed.includes(value);
  const [custom, setCustom] = useState(!known);
  return (
    <>
      <select
        id={id}
        className="settings-select"
        value={custom ? OTHER : value}
        onChange={(e) => {
          if (e.target.value === OTHER) return setCustom(true);
          setCustom(false);
          onChange(e.target.value);
        }}
      >
        {defaults.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
        {bundled.length > 0 && (
          <optgroup label="Included with Chappe">
            {bundled.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        )}
        {installed.length > 0 && (
          <optgroup label="Installed on this computer">
            {installed.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        )}
        <option value={OTHER}>Other font…</option>
      </select>
      {custom && <CustomFont value={known ? "" : value} onCommit={onChange} />}
    </>
  );
}

function ThemeCard({ theme, selected, onSelect }: { theme: Theme; selected: boolean; onSelect(): void }) {
  const c = theme.colors;
  const chips = [c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan];
  return (
    <button type="button" role="radio" aria-checked={selected} className="theme-card" onClick={onSelect}>
      <span className="theme-sample" style={{ background: c.background, color: c.foreground }}>
        <span>
          <span style={{ color: c.blue }}>~</span> <span style={{ color: theme.accent }}>❯</span> ls
        </span>
        <span className="theme-chips">
          {chips.map((color, i) => (
            <span key={i} style={{ background: color }} />
          ))}
        </span>
      </span>
      <span className="theme-name">
        {theme.name}
        <span className="theme-kind">{theme.light ? "Light" : "Dark"}</span>
      </span>
    </button>
  );
}

function Stepper({ id, value, onChange }: { id: string; value: number; onChange(value: number): void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const set = (next: number) => {
    if (!Number.isFinite(next)) return setDraft(String(value));
    const clamped = Math.min(FONT_SIZES.max, Math.max(FONT_SIZES.min, Math.round(next)));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };
  return (
    <span className="stepper">
      <button type="button" aria-label="Smaller" disabled={value <= FONT_SIZES.min} onClick={() => set(value - 1)}>
        −
      </button>
      <input
        id={id}
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ""))}
        onBlur={() => set(Number(draft))}
        onKeyDown={(e) => {
          if (e.key === "Enter") set(Number(draft));
          if (e.key === "ArrowUp") (e.preventDefault(), set(value + 1));
          if (e.key === "ArrowDown") (e.preventDefault(), set(value - 1));
        }}
      />
      <button type="button" aria-label="Larger" disabled={value >= FONT_SIZES.max} onClick={() => set(value + 1)}>
        +
      </button>
    </span>
  );
}

function CustomFont({ value, onCommit }: { value: string; onCommit(family: string): void }) {
  const [draft, setDraft] = useState(value);
  const [checked, setChecked] = useState(value);
  const missing = checked !== "" && !fontInstalled(checked);
  const commit = () => {
    const family = draft.trim();
    setChecked(family);
    onCommit(family);
  };
  return (
    <>
      <input
        className="settings-input"
        placeholder="Font name, as installed"
        aria-label="Font name"
        spellCheck={false}
        autoFocus={value === ""}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      {missing && (
        <p className="settings-hint settings-warning">
          “{checked}” isn't installed on this computer: the next font in line is used.
        </p>
      )}
    </>
  );
}

/** A made-up session in the chosen colours and font. */
function Preview({ theme, settings }: { theme: Theme; settings: Settings }) {
  const c = theme.colors;
  const prompt = (
    <>
      <span style={{ color: c.blue }}>~/projects</span> <span style={{ color: theme.accent }}>❯</span>{" "}
    </>
  );
  const cursor = (
    <span
      className="preview-cursor"
      data-style={settings.cursorStyle}
      style={{ background: settings.cursorStyle === "block" ? c.cursor : undefined, borderColor: c.cursor }}
    >
      {settings.cursorStyle === "block" ? " " : ""}
    </span>
  );
  return (
    <div
      className="settings-preview"
      aria-label="Preview"
      style={{
        background: c.background,
        color: c.foreground,
        fontFamily: fontStack(settings.fontFamily),
        fontSize: settings.fontSize,
        lineHeight: settings.lineHeight,
      }}
    >
      <div>
        {prompt}ls
      </div>
      <div>
        <span style={{ color: c.blue, fontWeight: 700 }}>src</span>
        {"  "}
        <span style={{ color: c.green, fontWeight: 700 }}>build.sh</span>
        {"  "}README.md{"  "}
        <span style={{ color: c.cyan }}>docs →</span>
      </div>
      <div>
        {prompt}git status <span style={{ color: c.brightBlack }}>--short</span>
      </div>
      <div>
        <span style={{ color: c.red }}> M</span> src/App.tsx
      </div>
      <div>
        <span style={{ color: c.green }}>A </span> src/settings.ts
      </div>
      <div>
        <span style={{ color: c.yellow }}>warning:</span> 2 files changed {"{0O 1lI}"}
      </div>
      <div>
        {prompt}
        {cursor}
      </div>
      <div className="preview-palette" aria-hidden="true">
        {[c.black, c.red, c.green, c.yellow, c.blue, c.magenta, c.cyan, c.white].map((color, i) => (
          <span key={i} style={{ background: color }} />
        ))}
        {[c.brightBlack, c.brightRed, c.brightGreen, c.brightYellow, c.brightBlue, c.brightMagenta, c.brightCyan, c.brightWhite].map(
          (color, i) => (
            <span key={`b${i}`} style={{ background: color }} />
          ),
        )}
      </div>
    </div>
  );
}
