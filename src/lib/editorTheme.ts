import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { alpha, mix, uiColors, type Theme } from "./themes";
import { fontStack, type Settings } from "./settings";

/** The editor wears the terminal's palette, so switching tabs never jars. */
export function editorTheme(theme: Theme, settings: Settings): Extension {
  const c = theme.colors;
  const ui = uiColors(theme);
  const font = fontStack(settings.fontFamily);
  const view = EditorView.theme(
    {
      "&": {
        height: "100%",
        color: c.foreground,
        backgroundColor: c.background,
        fontSize: `${settings.editorFontSize}px`,
      },
      ".cm-scroller": {
        fontFamily: font,
        lineHeight: "1.55",
      },
      ".cm-content": { caretColor: c.cursor, padding: "8px 0" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: c.cursor, borderLeftWidth: "2px" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
        { backgroundColor: c.selection ?? alpha(c.blue, theme.light ? 0.25 : 0.3) },
      ".cm-activeLine": { backgroundColor: alpha(c.foreground, theme.light ? 0.04 : 0.028) },
      ".cm-gutters": {
        backgroundColor: c.background,
        color: ui["ink-faint"],
        border: "none",
        paddingLeft: "6px",
      },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: ui["ink-muted"] },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 6px" },
      ".cm-foldGutter .cm-gutterElement": { color: ui["ink-faint"] },
      ".cm-foldPlaceholder": { backgroundColor: ui.raised, border: "none", color: ui["ink-muted"] },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: alpha(theme.accent, 0.15),
        outline: `1px solid ${alpha(theme.accent, 0.4)}`,
      },
      ".cm-searchMatch": { backgroundColor: alpha(theme.accent, 0.2), outline: `1px solid ${alpha(theme.accent, 0.4)}` },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: alpha(theme.accent, 0.4) },
      ".cm-selectionMatch": { backgroundColor: alpha(c.blue, 0.15) },
      ".cm-tooltip": { backgroundColor: ui.menu, border: `1px solid ${ui.line}`, color: c.foreground },
      ".cm-panels": { backgroundColor: ui.chrome, color: c.foreground },
      ".cm-panels.cm-panels-bottom": { borderTop: `1px solid ${ui.line}` },
      ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${ui.line}` },
      ".cm-panel.cm-search": { padding: "8px 12px", fontFamily: "var(--font-ui)", fontSize: "calc(13px * var(--ui-scale))" },
      ".cm-panel.cm-search label": { color: ui["ink-muted"], marginRight: "10px" },
      ".cm-panel.cm-search input[type=checkbox]": { accentColor: theme.accent, marginRight: "4px" },
      ".cm-textfield": {
        backgroundColor: c.background,
        border: `1px solid ${ui.line}`,
        borderRadius: "5px",
        color: c.foreground,
        padding: "3px 8px",
        fontFamily: font,
        fontSize: "12px",
      },
      ".cm-textfield:focus": { outline: "none", borderColor: theme.accent },
      ".cm-button": {
        backgroundImage: "none",
        backgroundColor: ui.raised,
        border: "none",
        borderRadius: "5px",
        color: c.foreground,
        padding: "3px 10px",
        fontFamily: "var(--font-ui)",
        fontSize: "calc(13px * var(--ui-scale))",
      },
      ".cm-button:active": { backgroundColor: ui["button-hover"] },
      ".cm-panel.cm-search [name=close]": { color: ui["ink-muted"], fontSize: "16px", right: "8px" },
      ".cm-panel.cm-gotoLine": { padding: "8px 12px", fontFamily: "var(--font-ui)" },
    },
    { dark: !theme.light },
  );

  // On a light background the bright colours are often too pale for text.
  const strong = (normal: string, bright: string) => (theme.light ? normal : bright);
  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: c.magenta },
    { tag: [t.string, t.special(t.string), t.regexp], color: c.green },
    { tag: [t.number, t.bool, t.null, t.atom], color: c.cyan },
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: ui["ink-faint"], fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: c.blue },
    { tag: [t.typeName, t.className, t.namespace], color: strong(c.cyan, c.brightCyan) },
    { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: strong(c.foreground, c.brightWhite) },
    { tag: [t.propertyName, t.attributeName], color: strong(c.yellow, c.brightYellow) },
    { tag: [t.tagName, t.heading], color: c.red, fontWeight: "600" },
    { tag: [t.link, t.url], color: c.blue, textDecoration: "underline" },
    { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: mix(c.background, c.foreground, 0.72) },
    { tag: [t.meta, t.processingInstruction], color: strong(c.magenta, c.brightMagenta) },
    { tag: t.invalid, color: strong(c.red, c.brightRed) },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.inserted, color: c.green },
    { tag: t.deleted, color: c.red },
    { tag: t.changed, color: c.yellow },
  ]);

  return [view, syntaxHighlighting(highlight)];
}
