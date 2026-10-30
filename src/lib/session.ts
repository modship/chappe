import { Channel, invoke } from "@tauri-apps/api/core";

export type Prompt =
  | { kind: "hostKey"; host: string; port: number; algorithm: string; fingerprint: string }
  | { kind: "password"; user: string; host: string; canRemember: boolean; retry: boolean }
  | { kind: "passphrase"; keyPath: string; retry: boolean }
  | {
      kind: "keyboardInteractive";
      user: string;
      host: string;
      name: string;
      instructions: string;
      fields: { label: string; echo: boolean }[];
    };

export type PromptReply =
  | { kind: "hostKey"; accept: boolean }
  | { kind: "secret"; value: string; remember: boolean }
  | { kind: "answers"; values: string[] };

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  error: string | null;
}

export type TerminalEvent =
  | { type: "status"; message: string }
  | { type: "connected" }
  | { type: "prompt"; promptId: number; prompt: Prompt }
  | ({ type: "exit" } & ExitInfo);

export interface SessionHandlers {
  onData(bytes: Uint8Array): void;
  onEvent(event: TerminalEvent): void;
}

function channels(handlers: SessionHandlers) {
  const onData = new Channel<ArrayBuffer>();
  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  const onEvent = new Channel<TerminalEvent>();
  onEvent.onmessage = (event) => handlers.onEvent(event);
  return { onData, onEvent };
}

export function replyToPrompt(promptId: number, reply: PromptReply | null): Promise<void> {
  return invoke("terminal_prompt_reply", { promptId, reply });
}

/**
 * A running terminal session on the Rust side, local or SSH.
 *
 * Input goes through a small queue: invokes run concurrently on the Rust
 * side, so two keystrokes sent back to back could otherwise land in the
 * wrong order.
 */
export class TerminalSession {
  private pending = "";
  private inFlight = false;
  private closed = false;

  private constructor(readonly id: number) {}

  static async local(profile: string, cols: number, rows: number, handlers: SessionHandlers) {
    const info = await invoke<{ id: number; shell: string }>("local_spawn", {
      cols,
      rows,
      profile,
      cwd: null,
      ...channels(handlers),
    });
    return { session: new TerminalSession(info.id), shell: info.shell };
  }

  static async ssh(serverId: string, cols: number, rows: number, handlers: SessionHandlers) {
    const info = await invoke<{ id: number; label: string; address: string }>("ssh_connect", {
      serverId,
      cols,
      rows,
      ...channels(handlers),
    });
    return { session: new TerminalSession(info.id), address: info.address };
  }

  write(data: string): void {
    if (this.closed) return;
    this.pending += data;
    void this.flush();
  }

  /** Legacy mouse reports: one byte per char, not UTF-8. */
  writeBinary(data: string): void {
    if (this.closed) return;
    void invoke("terminal_write", { id: this.id, data, binary: true });
  }

  private async flush(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.pending && !this.closed) {
        const data = this.pending;
        this.pending = "";
        await invoke("terminal_write", { id: this.id, data });
      }
    } catch (e) {
      console.error("terminal_write", e);
    } finally {
      this.inFlight = false;
    }
  }

  resize(cols: number, rows: number): void {
    if (this.closed) return;
    void invoke("terminal_resize", { id: this.id, cols, rows });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void invoke("terminal_close", { id: this.id });
  }
}
