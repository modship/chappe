import type { IBuffer, IBufferCell, IMarker, Terminal } from "@xterm/xterm";

/**
 * Notices the commands typed in a terminal, without any help from the shell.
 *
 * When Enter is pressed, the command is read from the screen: what the shell
 * shows is what it runs, including lines recalled with ↑ or completed with
 * Tab. The prompt is told apart from the command by where the cursor stood
 * before the first key of the line. Shells that mark their prompts (OSC 133,
 * as set up by iTerm2 or VS Code shell integration) give that position
 * exactly, and also tell a shell prompt from a program reading input.
 *
 * Left out: full-screen programs, input the program doesn't echo
 * (passwords), and lines starting with a space, which shells also keep out
 * of their history.
 */

type Write = (data: Uint8Array, done?: () => void) => void;

interface Start {
  marker: IMarker;
  x: number;
  /** A paste brought several lines into the shell's editor. */
  multiline: boolean;
  /**
   * Something stood before it on its row. A shell command always follows a
   * prompt; a bare line is input for a program (`read`, `cat`).
   */
  prompted: boolean;
}

interface Cell {
  ch: string;
  line: number;
  /** -1 for the break between two lines. */
  x: number;
  ghost: boolean;
}

/** Why a command can't be run in this terminal right now, if it can't. */
export type Busy = "fullscreen" | "running" | "typing";

/** The shell echoes the newline after the line it runs; failing that, read anyway. */
const ECHO_TIMEOUT = 1000;
const NEWLINE = 0x0a;

/**
 * Grey or faint text after the cursor is a suggestion the shell shows but
 * won't run (zsh-autosuggestions, fish, PowerShell predictions).
 */
function isGhost(cell: IBufferCell): boolean {
  if (cell.isDim()) return true;
  if (cell.isFgPalette()) {
    const color = cell.getFgColor();
    return color === 8 || (color >= 236 && color <= 248);
  }
  if (cell.isFgRGB()) {
    const color = cell.getFgColor();
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    return Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && r >= 0x40 && r <= 0xa0;
  }
  return false;
}

/** The cells from row `from` to row `to`, one per character. */
function cellsOf(buffer: IBuffer, from: number, to: number): Cell[] {
  const cells: Cell[] = [];
  let scratch: IBufferCell | undefined;
  for (let y = from; y <= to; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    if (y > from && !line.isWrapped) cells.push({ ch: "\n", line: y, x: -1, ghost: false });
    const row: Cell[] = [];
    for (let x = 0; x < line.length; x++) {
      scratch = line.getCell(x, scratch);
      if (!scratch) break;
      // The second half of a wide character.
      if (scratch.getWidth() === 0) continue;
      row.push({ ch: scratch.getChars() || " ", line: y, x, ghost: isGhost(scratch) });
    }
    // Blanks at the end of a row only matter when the line goes on.
    const continues = y < to && buffer.getLine(y + 1)?.isWrapped;
    if (!continues) while (row.length && row[row.length - 1].ch === " ") row.pop();
    cells.push(...row);
  }
  return cells;
}

const textOf = (cells: Cell[]) => cells.map((c) => c.ch).join("");

export class CommandCapture {
  private start: Start | null = null;
  /** The prompt last seen before a command, to find it again if needed. */
  private prompt = "";
  /** The shell marks its prompts (OSC 133). */
  private integrated = false;
  /** With marks: the shell is waiting for a command. */
  private atPrompt = false;
  /** Enter was pressed; the line is read once the shell has echoed it. */
  private pending: { start: Start | null; timer: number } | null = null;
  private disposers: { dispose(): void }[] = [];

  constructor(
    private readonly term: Terminal,
    private readonly write: Write,
    private readonly onCommand: (command: string) => void,
  ) {
    this.disposers.push(term.parser.registerOscHandler(133, (data) => this.mark(data)));
  }

  dispose() {
    this.disposers.forEach((d) => d.dispose());
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.clearStart();
  }

  /** Keys and pastes on their way to the shell. */
  input(data: string) {
    if (this.fullscreen()) return;
    if (data === "\r") return this.enter();
    // Ctrl+C drops the line; Ctrl+L draws it again elsewhere.
    if (data === "\x03" || data === "\x0c") return this.clearStart();
    const multiline = data.length > 1 && /[\r\n]/.test(data);
    // Escape sequences (Alt+Enter, a bracketed paste) never run a line.
    if (multiline && !data.startsWith("\x1b")) return this.unbracketedPaste(data);
    if (!this.start && !this.integrated) this.markStart();
    if (this.start && multiline && data.startsWith("\x1b[200~")) this.start.multiline = true;
  }

  /** Output from the shell, written to the terminal through here. */
  output(data: Uint8Array) {
    if (!this.pending) return this.write(data);
    const newline = data.indexOf(NEWLINE);
    if (newline === -1) return this.write(data);
    // Read the line once the shell has redrawn it for the last time, just
    // before it moves on.
    this.write(data.subarray(0, newline), () => this.settle());
    this.write(data.subarray(newline));
  }

  /** A command sent by the app itself, as if typed and run. */
  ran(command: string) {
    this.clearStart();
    this.atPrompt = false;
    this.record(command);
  }

  /** Whether running a command now would land somewhere unexpected. */
  busy(): Busy | null {
    if (this.fullscreen()) return "fullscreen";
    if (this.integrated && !this.atPrompt) return "running";
    if (this.start && this.read(this.start)?.trim()) return "typing";
    return null;
  }

  private fullscreen() {
    return this.term.buffer.active.type === "alternate";
  }

  private mark(data: string): boolean {
    const kind = data.split(";")[0];
    if (kind === "B") {
      this.integrated = true;
      this.atPrompt = true;
      this.markStart();
    } else if (kind === "A" || kind === "C") {
      this.atPrompt = false;
      this.clearStart();
    }
    return true;
  }

  private markStart() {
    this.clearStart();
    const marker = this.term.registerMarker(0);
    if (!marker) return;
    const x = this.term.buffer.active.cursorX;
    const prompt = this.term.buffer.active.getLine(marker.line)?.translateToString(false, 0, x) ?? "";
    const prompted = prompt.trim() !== "";
    this.start = { marker, x, multiline: false, prompted };
    if (prompted) this.prompt = prompt;
  }

  private clearStart() {
    this.start?.marker.dispose();
    this.start = null;
  }

  private enter() {
    // A second Enter before the echo of the first: settle the first now.
    if (this.pending) this.settle();
    const start = this.start;
    this.start = null;
    if ((this.integrated && !this.atPrompt) || (start && !start.prompted)) {
      // Input for a program, not a command for the shell.
      start?.marker.dispose();
      return;
    }
    this.atPrompt = false;
    this.pending = { start, timer: window.setTimeout(() => this.settle(), ECHO_TIMEOUT) };
  }

  private settle() {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    const command = this.fullscreen() ? null : this.read(pending.start);
    pending.start?.marker.dispose();
    if (command) this.record(command);
  }

  /** Without bracketed paste, each line of a paste runs as it arrives. */
  private unbracketedPaste(data: string) {
    if (!this.start && !this.integrated) this.markStart();
    if ((this.integrated && !this.atPrompt) || (this.start && !this.start.prompted)) return this.clearStart();
    const typed = this.start ? (this.read(this.start) ?? "") : "";
    const lines = data.split(/\r\n?|\n/);
    const rest = lines.pop() ?? "";
    lines.forEach((line, i) => this.record(i === 0 ? typed + line : line));
    this.clearStart();
    if (rest) this.markStart();
  }

  private record(command: string) {
    // A leading space keeps a command out of shell history; same here.
    if (/^\s/.test(command)) return;
    const trimmed = command.trim();
    // Nothing typed, or a password shown as stars.
    if (!trimmed || /^[*•●]+$/.test(trimmed)) return;
    this.onCommand(trimmed);
  }

  /** The command on screen, from `start` (or after the prompt) to the end of the cursor's line. */
  private read(start: Start | null): string | null {
    const buffer = this.term.buffer.active;
    const cursorLine = buffer.baseY + buffer.cursorY;
    const cursorX = buffer.cursorX;
    let top = cursorLine;
    while (top > 0 && buffer.getLine(top)?.isWrapped) top--;
    let bottom = cursorLine;
    while (buffer.getLine(bottom + 1)?.isWrapped) bottom++;

    const startLine = start && !start.marker.isDisposed ? start.marker.line : -1;
    const usable =
      startLine >= 0 &&
      startLine <= cursorLine &&
      (startLine >= top || (start!.multiline && cursorLine - startLine < 200));

    let cells: Cell[];
    let begin: number;
    if (usable) {
      cells = cellsOf(buffer, startLine, bottom);
      begin = cells.findIndex((c) => c.line > startLine || c.x >= start!.x);
      if (begin === -1) return "";
    } else {
      // The line was drawn again (a completion list, a cleared screen): find
      // the prompt in it instead.
      cells = cellsOf(buffer, top, bottom);
      begin = this.afterPrompt(cells);
      if (begin === -1) return null;
    }

    let end = cells.length;
    const cursor = cells.findIndex((c) => c.line > cursorLine || (c.line === cursorLine && c.x >= cursorX));
    if (cursor !== -1) {
      const from = Math.max(begin, cursor);
      const ghost = cells.findIndex((c, i) => i >= from && c.ghost && c.ch !== " ");
      if (ghost !== -1) end = ghost;
      end = Math.min(end, this.rightPrompt(cells, from, end));
    }
    end = this.dropTrailingGhost(cells, begin, end);
    return textOf(cells.slice(begin, end)).trimEnd();
  }

  /** Where the command starts in a line that begins with the prompt, or -1. */
  private afterPrompt(cells: Cell[]): number {
    const text = textOf(cells);
    const indexAt = (offset: number) => {
      let length = 0;
      for (let i = 0; i < cells.length; i++) {
        if (length >= offset) return i;
        length += cells[i].ch.length;
      }
      return cells.length;
    };
    if (this.prompt && text.startsWith(this.prompt)) return indexAt(this.prompt.length);
    // The prompt changed (another folder): look for how it ended, "% " or "$ ".
    const tail = this.prompt.trimEnd().slice(-1);
    const ending = tail ? text.indexOf(tail + " ") : -1;
    if (ending !== -1) return indexAt(ending + 2);
    const generic = /[$#%>❯➜»λ] /.exec(text);
    return generic ? indexAt(generic.index + 2) : -1;
  }

  /**
   * zsh moves the cursor past a suggestion before running the line, so a
   * grey tail is a suggestion too, wherever the cursor is.
   */
  private dropTrailingGhost(cells: Cell[], begin: number, end: number): number {
    let last = end;
    while (last > begin && cells[last - 1].ch === " ") last--;
    let first = last;
    while (first > begin && (cells[first - 1].ghost || cells[first - 1].ch === " ")) first--;
    const ghostly = cells.slice(first, last).some((c) => c.ghost && c.ch !== " ");
    return ghostly ? first : end;
  }

  /**
   * zsh can show a second prompt flush right (RPROMPT). Text after a wide
   * gap, ending at the right edge, on the command's only row, is that.
   */
  private rightPrompt(cells: Cell[], from: number, end: number): number {
    const last = cells[end - 1];
    if (!last || last.x < this.term.cols - 3) return end;
    for (let i = from; i < end - 1; i++) {
      if (cells[i].line !== last.line) return end;
    }
    for (let i = from; i < end - 2; i++) {
      if (cells[i].ch === " " && cells[i + 1].ch === " ") return i;
    }
    return end;
  }
}
