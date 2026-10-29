import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { TabTarget } from "../App";
import {
  replyToPrompt,
  TerminalSession,
  type ExitInfo,
  type Prompt,
  type PromptReply,
  type SessionHandlers,
} from "../lib/session";
import { matchShortcut } from "../lib/shortcuts";
import { fontStack, loadFont, type Settings } from "../lib/settings";
import { themeById, xtermTheme } from "../lib/themes";
import { isMac, platform } from "../lib/platform";
import { PromptCard } from "./PromptCard";
import { CommandCapture, type Busy } from "../lib/commandCapture";

/** What the app can ask of a terminal (menu items, shortcuts). */
export interface TerminalApi {
  copy(): Promise<void>;
  paste(): Promise<void>;
  selectAll(): void;
  focus(): void;
  /** Types text into the shell, as if from the keyboard. */
  sendText(text: string): void;
  /** Puts a command on the shell's line, without running it. */
  insert(command: string): void;
  /** Runs a command, unless that would land somewhere unexpected. */
  run(command: string): Busy | null;
}

export type SessionState = "connecting" | "live" | "ended";

interface Props {
  target: Extract<TabTarget, { kind: "local" | "ssh" }>;
  settings: Settings;
  /** Shown in the window. */
  active: boolean;
  /** Takes keyboard focus; false while a dialog is open over it. */
  focused: boolean;
  onReady(api: TerminalApi): void;
  onInfo(info: { shell?: string; address?: string; sessionId: number }): void;
  /** The shell's folder, when it reports it (OSC 7). */
  onCwd(path: string): void;
  onState(state: SessionState): void;
  onTitle(title: string): void;
  /** A command was typed and run. */
  onCommand(command: string): void;
  onSize(cols: number, rows: number): void;
  /** The session is over. Returns true when the tab is being closed. */
  onEnd(info: ExitInfo): boolean;
  onReconnect(): void;
  onClose(): void;
}

const dim = (text: string) => `\x1b[2m${text}\x1b[0m`;
const red = (text: string) => `\x1b[31m${text}\x1b[0m`;

function endMessage({ code, signal }: ExitInfo, remote: boolean): string {
  const what = remote ? "Session ended" : "Process exited";
  if (signal) return `${what} by signal ${signal}`;
  if (code === null) return what;
  return `${what} with code ${code}`;
}

interface PendingPrompt {
  id: number;
  prompt: Prompt;
}

export function TerminalView(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [prompt, setPrompt] = useState<PendingPrompt | null>(null);
  const [ended, setEnded] = useState<ExitInfo | null>(null);
  const wasLive = useRef(false);
  // Callbacks change on every render; the terminal lives for the whole tab.
  const cb = useRef(props);
  cb.current = props;
  const remote = props.target.kind === "ssh";

  useEffect(() => {
    const host = hostRef.current!;
    let disposed = false;
    let session: TerminalSession | null = null;

    const settings = cb.current.settings;
    const term = new Terminal({
      fontFamily: fontStack(settings.fontFamily),
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      cursorWidth: 2,
      cursorInactiveStyle: "outline",
      scrollback: settings.scrollback,
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: isMac,
      drawBoldTextInBrightColors: false,
      theme: xtermTheme(themeById(settings.theme)),
    });
    termRef.current = term;

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    // Links open on ⌘/Ctrl-click only, so a stray click never launches a browser.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (isMac ? event.metaKey : event.ctrlKey) void openUrl(uri);
      }),
    );

    // App shortcuts must not reach the shell; returning false lets the
    // event bubble to the app (or the native menu) untouched.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Windows Terminal habits: Ctrl+C copies when text is selected (and
      // interrupts otherwise), Ctrl+V pastes.
      if (platform === "windows" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
        if (e.code === "KeyC" && term.hasSelection()) {
          e.preventDefault();
          void writeText(term.getSelection());
          term.clearSelection();
          return false;
        }
        if (e.code === "KeyV") {
          e.preventDefault();
          void readText().then((text) => text && term.paste(text));
          return false;
        }
      }
      return !matchShortcut(e);
    });

    const api: TerminalApi = {
      async copy() {
        const text = term.getSelection();
        if (text) await writeText(text);
      },
      async paste() {
        const text = await readText();
        if (text) term.paste(text);
      },
      selectAll: () => term.selectAll(),
      focus: () => term.focus(),
      sendText: (text) => {
        session?.write(text);
        term.focus();
      },
      insert: (command) => {
        // A paste: bracketed when the shell asks for it, so nothing runs.
        term.paste(command);
        term.focus();
      },
      run: (command) => {
        const busy = capture.busy();
        if (busy || !session) return busy ?? "running";
        term.paste(command);
        capture.ran(command);
        session.write("\r");
        term.focus();
        return null;
      },
    };

    // OSC 7: "file://host/path", sent by shells set up to report their folder.
    term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        if (url.protocol === "file:") {
          const path = decodeURIComponent(url.pathname);
          // file:///C:/Users on Windows
          cb.current.onCwd(/^\/[A-Za-z]:/.test(path) ? path.slice(1).replace(/\//g, "\\") : path);
        }
      } catch {
        // Not a URL: ignore.
      }
      return true;
    });

    // Some WebGL compositors only present a frame once the next one is
    // drawn. A blinking cursor keeps frames coming, but an unfocused or
    // finished terminal has none, and its last lines would never show. One
    // extra frame shortly after each burst of output settles it.
    let nudgeTimer = 0;
    let resizeTimer = 0;
    const nudge = () => {
      clearTimeout(nudgeTimer);
      nudgeTimer = window.setTimeout(() => term.refresh(0, term.rows - 1), 50);
    };
    const write = (data: string | Uint8Array) => term.write(data, nudge);
    const capture = new CommandCapture(
      term,
      (data, done) =>
        term.write(data, () => {
          nudge();
          done?.();
        }),
      (command) => cb.current.onCommand(command),
    );

    let frame = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleFit);

    const finish = (info: ExitInfo) => {
      if (disposed) return;
      setPrompt(null);
      const clean = info.code === 0 && !info.signal && !info.error;
      if (info.error) write(`\r\n${red(info.error)}\r\n`);
      else if (!clean) write(`\r\n${dim(`[${endMessage(info, remote)}]`)}\r\n`);
      // Hide the cursor (DECTCEM). Keystrokes need no blocking: the session
      // is gone on the Rust side. Changing options such as `cursorBlink` or
      // `disableStdin` here stalls the WebGL renderer in xterm 6.
      write("\x1b[?25l");
      cb.current.onState("ended");
      const closing = cb.current.onEnd(info);
      if (!closing) setEnded(info);
    };

    const handlers: SessionHandlers = {
      onData: (bytes) => capture.output(bytes),
      onEvent: (event) => {
        switch (event.type) {
          case "status":
            write(`${dim(event.message)}\r\n`);
            break;
          case "connected":
            wasLive.current = true;
            cb.current.onState("live");
            break;
          case "prompt":
            setPrompt({ id: event.promptId, prompt: event.prompt });
            break;
          case "exit":
            finish(event);
            break;
        }
      },
    };

    (async () => {
      await loadFont(settings.fontFamily, settings.fontSize);
      if (disposed) return;

      term.open(host);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch (e) {
        console.warn("WebGL unavailable, using the DOM renderer", e);
      }
      fit.fit();
      resizeObserver.observe(host);
      cb.current.onSize(term.cols, term.rows);

      const target = cb.current.target;
      if (target.kind === "local") {
        const started = await TerminalSession.local(target.profileId, term.cols, term.rows, handlers);
        session = started.session;
        cb.current.onInfo({ shell: started.shell, sessionId: started.session.id });
        cb.current.onState("live");
      } else {
        cb.current.onState("connecting");
        const started = await TerminalSession.ssh(target.serverId, term.cols, term.rows, handlers);
        session = started.session;
        cb.current.onInfo({ address: started.address, sessionId: started.session.id });
      }
      if (disposed) {
        session.close();
        return;
      }

      const live = session;
      term.onData((data) => {
        capture.input(data);
        live.write(data);
      });
      term.onBinary((data) => live.writeBinary(data));
      // Dragging the sidebar resizes on every frame; the shell (and an SSH
      // server) only needs the size once it settles.
      term.onResize(({ cols, rows }) => {
        cb.current.onSize(cols, rows);
        clearTimeout(resizeTimer);
        resizeTimer = window.setTimeout(() => live.resize(cols, rows), 60);
      });
      term.onTitleChange((title) => cb.current.onTitle(title));

      cb.current.onReady(api);
      if (cb.current.active && cb.current.focused) term.focus();
    })().catch((e) => {
      const what = cb.current.target.kind === "local" ? "start the shell" : "connect";
      finish({ code: null, signal: null, error: `Couldn't ${what}: ${String(e)}` });
    });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(nudgeTimer);
      clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      session?.close();
      capture.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // Settings apply to running terminals too (except the cursor blink, which
  // xterm.js 6 can't change on a live WebGL terminal).
  const { theme, fontFamily, fontSize, lineHeight, cursorStyle, scrollback } = props.settings;
  useEffect(() => {
    const term = termRef.current;
    if (!term?.element) return;
    term.options.theme = xtermTheme(themeById(theme));
    term.options.cursorStyle = cursorStyle;
    term.options.scrollback = scrollback;
  }, [theme, cursorStyle, scrollback]);

  useEffect(() => {
    let stale = false;
    void loadFont(fontFamily, fontSize).then(() => {
      const term = termRef.current;
      if (stale || !term?.element) return;
      term.options.fontFamily = fontStack(fontFamily);
      term.options.fontSize = fontSize;
      term.options.lineHeight = lineHeight;
      const host = hostRef.current;
      if (host && host.clientWidth > 0) fitRef.current?.fit();
      term.refresh(0, term.rows - 1);
    });
    return () => {
      stale = true;
    };
  }, [fontFamily, fontSize, lineHeight]);

  useEffect(() => {
    if (!props.active) return;
    const term = termRef.current;
    const host = hostRef.current;
    if (term?.element && host && host.clientWidth > 0) fitRef.current?.fit();
  }, [props.active]);

  useEffect(() => {
    if (props.active && props.focused && !prompt) termRef.current?.focus();
  }, [props.active, props.focused, prompt]);

  const answer = (reply: PromptReply | null) => {
    if (!prompt) return;
    void replyToPrompt(prompt.id, reply);
    setPrompt(null);
    termRef.current?.focus();
  };

  return (
    <div className="term-pane" data-active={props.active}>
      <div ref={hostRef} className="term-host" />
      {prompt && <PromptCard prompt={prompt.prompt} onReply={answer} />}
      {ended && (
        <div className="ended-bar" role="status">
          <span>{ended.error ? (wasLive.current ? "Disconnected." : "Couldn't connect.") : `${endMessage(ended, remote)}.`}</span>
          <span className="ended-actions">
            {remote && (
              <button type="button" className="button-primary button-small" autoFocus onClick={props.onReconnect}>
                Reconnect
              </button>
            )}
            <button type="button" className="button-quiet button-small" autoFocus={!remote} onClick={props.onClose}>
              Close tab
            </button>
          </span>
        </div>
      )}
    </div>
  );
}
