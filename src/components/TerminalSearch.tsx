import { useEffect, useRef, useState } from "react";
import type { ISearchOptions, SearchAddon } from "@xterm/addon-search";
import { mix, type Theme } from "../lib/themes";
import { isMac } from "../lib/platform";

interface Props {
  addon: SearchAddon;
  theme: Theme;
  /** Text to start with: the terminal's selection, if any. */
  initial: string;
  /** Bumped when ⌘F is pressed again while open, to select the query. */
  focusKey: number;
  /** Clears the terminal's selection, where searches start from. */
  onRestart(): void;
  onClose(): void;
}

/** Matches highlighted at most; beyond this the count reads "1,000+". */
export const HIGHLIGHT_LIMIT = 1000;

/** Find in the terminal's output and scrollback. */
export function TerminalSearch({ addon, theme, initial, focusKey, onRestart, onClose }: Props) {
  const [query, setQuery] = useState(initial);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);

  useEffect(() => {
    const sub = addon.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    );
    return () => sub.dispose();
  }, [addon]);

  // Colours must be plain #rrggbb: blend them over the background.
  const c = theme.colors;
  const options = (): ISearchOptions => ({
    caseSensitive,
    wholeWord,
    regex,
    decorations: {
      matchBackground: mix(c.background, theme.accent, 0.3),
      matchOverviewRuler: mix(c.background, theme.accent, 0.6),
      activeMatchBackground: mix(c.background, theme.accent, 0.75),
      activeMatchBorder: theme.accent,
      activeMatchColorOverviewRuler: theme.accent,
    },
  });

  const validRegex = (() => {
    if (!regex || !query) return true;
    try {
      new RegExp(query);
      return true;
    } catch {
      return false;
    }
  })();

  // Typing searches as you go, from the bottom up each time: the latest
  // output is usually what you're after.
  useEffect(() => {
    if (!query || !validRegex) {
      addon.clearDecorations();
      setResults(null);
      return;
    }
    onRestart();
    addon.findPrevious(query, options());
  }, [query, caseSensitive, wholeWord, regex, theme]);

  // Closing removes the highlights.
  useEffect(() => () => addon.clearDecorations(), [addon]);

  /** Up the scrollback, towards older output. */
  const older = () => query && validRegex && addon.findPrevious(query, options());
  const newer = () => query && validRegex && addon.findNext(query, options());

  let count = "";
  if (query && !validRegex) count = "Invalid regex";
  else if (query && results) {
    if (results.count === 0) count = "No results";
    else if (results.index < 0) count = results.count >= HIGHLIGHT_LIMIT ? "1,000+" : `${results.count}`;
    else count = `${results.index + 1} of ${results.count >= HIGHLIGHT_LIMIT ? "1,000+" : results.count}`;
  }

  const toggle = (label: string, title: string, on: boolean, set: (value: boolean) => void) => (
    <button
      type="button"
      className="term-search-toggle"
      aria-pressed={on}
      aria-label={title}
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => set(!on)}
    >
      {label}
    </button>
  );

  return (
    <div
      className="term-search"
      role="search"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <input
        ref={inputRef}
        className="term-search-input"
        data-invalid={!validRegex || results?.count === 0 ? "true" : undefined}
        placeholder="Find"
        aria-label="Find in terminal"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) newer();
            else older();
          }
          // ⌘G / ⇧⌘G, as in most Mac apps.
          if (isMac && e.metaKey && e.code === "KeyG") {
            e.preventDefault();
            if (e.shiftKey) newer();
            else older();
          }
        }}
      />
      <span className="term-search-count" aria-live="polite">
        {count}
      </span>
      {toggle("Aa", "Match case", caseSensitive, setCaseSensitive)}
      {toggle("ab", "Whole word", wholeWord, setWholeWord)}
      {toggle(".*", "Regular expression", regex, setRegex)}
      <span className="term-search-sep" aria-hidden="true" />
      <button
        type="button"
        className="icon-button"
        aria-label="Older match"
        title="Older match, up (↵)"
        disabled={!results?.count}
        onMouseDown={(e) => e.preventDefault()}
        onClick={older}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 7.5L6 4l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button
        type="button"
        className="icon-button"
        aria-label="Newer match"
        title="Newer match, down (⇧↵)"
        disabled={!results?.count}
        onMouseDown={(e) => e.preventDefault()}
        onClick={newer}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 4.5L6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button type="button" className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onClose}>
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
