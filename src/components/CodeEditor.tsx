import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, openSearchPanel, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { editorTheme } from "../lib/editorTheme";
import { loadFont, type Settings } from "../lib/settings";
import { themeById } from "../lib/themes";
import { CONFLICT, saveTextFile, type EditorFile } from "../lib/editor";
import type { FsTarget } from "../lib/files";
import { ConfirmDialog } from "./ConfirmDialog";

/** What the app can ask of an editor (menu items, closing). */
export interface EditorApi {
  /** Resolves to true once the file is saved. */
  save(): Promise<boolean>;
  focus(): void;
  selectAll(): void;
  /** Opens the find panel. */
  find(): void;
}

export interface EditorInfo {
  language: string;
  eol: "LF" | "CRLF";
}

interface Props {
  file: EditorFile;
  settings: Settings;
  active: boolean;
  focused: boolean;
  /** Where to save, or why saving isn't possible right now. */
  resolveTarget(): FsTarget | string;
  onReady(api: EditorApi): void;
  onDirty(dirty: boolean): void;
  onCursor(line: number, col: number): void;
  onInfo(info: EditorInfo): void;
  onSaved(): void;
}

export function CodeEditor(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [conflict, setConflict] = useState(false);
  const cb = useRef(props);
  cb.current = props;
  const conflictSave = useRef<() => Promise<boolean>>(async () => false);
  const themeSlot = useRef(new Compartment());

  useEffect(() => {
    const { file } = cb.current;
    const crlf = file.initial.content.includes("\r\n");
    const bom = file.initial.bom;
    // What the file looked like on disk when last read or saved; a change
    // to either means someone else wrote it.
    let modified = file.initial.modified;
    let size = file.initial.size;
    let saved: Text;
    let dirty = false;
    const language = new Compartment();

    const setDirty = (value: boolean) => {
      if (value === dirty) return;
      dirty = value;
      cb.current.onDirty(value);
    };

    const save = async (force = false): Promise<boolean> => {
      const view = viewRef.current;
      if (!view) return false;
      const target = cb.current.resolveTarget();
      if (typeof target === "string") {
        setNotice({ text: target, error: true });
        return false;
      }
      const doc = view.state.doc;
      const text = doc.toString();
      try {
        const result = await saveTextFile(
          target,
          file.path,
          crlf ? text.replace(/\n/g, "\r\n") : text,
          bom,
          force ? null : { modified, size },
        );
        modified = result.modified;
        size = result.size;
        saved = doc;
        setDirty(!view.state.doc.eq(saved));
        setNotice(null);
        cb.current.onSaved();
        return true;
      } catch (e) {
        if (String(e) === CONFLICT) setConflict(true);
        else setNotice({ text: String(e), error: true });
        return false;
      }
    };

    const state = EditorState.create({
      doc: crlf ? file.initial.content.replace(/\r\n/g, "\n") : file.initial.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (void save(), true) },
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        language.of([]),
        themeSlot.current.of(editorTheme(themeById(cb.current.settings.theme), cb.current.settings)),
        // CodeMirror's own labels are lowercase; match the rest of the app.
        EditorState.phrases.of({
          next: "Next",
          previous: "Previous",
          all: "All",
          "match case": "Match case",
          regexp: "Regex",
          "by word": "Whole word",
          replace: "Replace",
          "replace all": "Replace all",
          close: "Close",
          Find: "Find",
          Replace: "Replace",
          "Go to line": "Go to line",
          go: "Go",
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            // Comparing documents is only worth it when the lengths match.
            const doc = update.state.doc;
            setDirty(doc.length !== saved.length || !doc.eq(saved));
          }
          if (update.selectionSet || update.docChanged) {
            const head = update.state.selection.main.head;
            const line = update.state.doc.lineAt(head);
            cb.current.onCursor(line.number, head - line.from + 1);
          }
        }),
      ],
    });
    saved = state.doc;

    const view = new EditorView({ state, parent: hostRef.current! });
    viewRef.current = view;

    const match = LanguageDescription.matchFilename(languages, file.name);
    cb.current.onInfo({ language: match?.name ?? "Plain text", eol: crlf ? "CRLF" : "LF" });
    cb.current.onCursor(1, 1);
    match
      ?.load()
      .then((support) => view.dispatch({ effects: language.reconfigure(support) }))
      .catch(() => {});

    cb.current.onReady({
      save: () => save(),
      focus: () => view.focus(),
      selectAll: () => view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }),
      find: () => {
        openSearchPanel(view);
      },
    });
    conflictSave.current = () => save(true);

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  const { settings } = props;
  useEffect(() => {
    let stale = false;
    void loadFont(settings.fontFamily, settings.editorFontSize).then(() => {
      if (stale) return;
      viewRef.current?.dispatch({
        effects: themeSlot.current.reconfigure(editorTheme(themeById(settings.theme), settings)),
      });
    });
    return () => {
      stale = true;
    };
  }, [settings]);

  useEffect(() => {
    if (props.active && props.focused) viewRef.current?.focus();
  }, [props.active, props.focused]);

  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);

  const where = props.file.origin.kind === "ssh" ? props.file.origin.serverName : "this computer";

  return (
    <div className="term-pane editor-pane" data-active={props.active}>
      <div ref={hostRef} className="editor-host" />
      {notice && (
        <div className="ended-bar" role={notice.error ? "alert" : "status"} data-error={notice.error}>
          <span>{notice.text}</span>
          <span className="ended-actions">
            <button type="button" className="button-quiet button-small" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </span>
        </div>
      )}
      {conflict && (
        <ConfirmDialog
          title={`${props.file.name} changed`}
          body={`It was modified on ${where} after you opened it. Saving replaces those changes with yours.`}
          confirm="Replace"
          danger
          onCancel={() => {
            setConflict(false);
            viewRef.current?.focus();
          }}
          onConfirm={() => {
            setConflict(false);
            viewRef.current?.focus();
            void conflictSave.current();
          }}
        />
      )}
    </div>
  );
}
