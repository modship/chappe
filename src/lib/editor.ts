import { invoke } from "@tauri-apps/api/core";
import type { FsTarget } from "./files";

export interface TextFile {
  content: string;
  /** Started with a UTF-8 byte order mark, kept on save. */
  bom: boolean;
  modified: number | null;
  size: number;
}

/** Where an open file came from, to know how to save it back. */
export type FileOrigin = { kind: "local" } | { kind: "ssh"; tabId: string; serverName: string };

export interface EditorFile {
  path: string;
  name: string;
  origin: FileOrigin;
  initial: TextFile;
}

/** What `fs_write_text` answers when the file changed since it was read. */
export const CONFLICT = "CONFLICT";

export const readTextFile = (target: FsTarget, path: string) => invoke<TextFile>("fs_read_text", { target, path });

/** `expected` is the file as last seen; null saves whatever is there now. */
export const saveTextFile = (
  target: FsTarget,
  path: string,
  content: string,
  bom: boolean,
  expected: { modified: number | null; size: number } | null,
) =>
  invoke<{ modified: number | null; size: number }>("fs_write_text", {
    target,
    path,
    content,
    bom,
    expected,
  });

/** Files that are never text: these open in their default app instead. */
const BINARY = new Set(
  (
    "png jpg jpeg gif bmp ico icns webp tif tiff heic psd ai sketch fig " +
    "pdf doc docx xls xlsx ppt pptx key numbers pages odt ods odp " +
    "zip gz tgz bz2 xz zst 7z rar tar jar war ear deb rpm dmg pkg msi iso img apk ipa " +
    "exe dll so dylib a o obj class pyc wasm bin dat db sqlite sqlite3 " +
    "mp3 wav flac ogg m4a aac mp4 mov mkv avi webm " +
    "ttf otf woff woff2 eot"
  ).split(" "),
);

export function opensInEditor(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || !BINARY.has(name.slice(dot + 1).toLowerCase());
}

export const sameOrigin = (a: FileOrigin, b: FileOrigin) =>
  a.kind === b.kind && (a.kind === "local" || a.tabId === (b as { tabId: string }).tabId);
