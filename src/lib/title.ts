import type { Tab } from "../App";

export function shellName(path?: string): string {
  if (!path) return "shell";
  return path.split(/[\\/]/).pop()!.replace(/\.exe$/i, "");
}

/**
 * zsh and bash usually set the title to "user@host: ~/path". The path is
 * what tells two tabs apart.
 */
export function titlePath(title: string): string | null {
  const match = /^[^@\s]+@[^:\s]+:\s*(.+)$/.exec(title.trim());
  return match ? match[1] : null;
}

/** Main and secondary text for a tab or session row. */
export function tabLabel(tab: Pick<Tab, "title" | "shell" | "target">): { main: string; detail?: string } {
  if (tab.target.kind === "settings") return { main: "Settings" };
  if (tab.target.kind === "editor") {
    const { file } = tab.target;
    return { main: file.name, detail: file.origin.kind === "ssh" ? file.origin.serverName : undefined };
  }
  const title = tab.title.trim();
  if (tab.target.kind === "ssh") {
    const path = title ? titlePath(title) ?? title : undefined;
    return { main: tab.target.name, detail: path };
  }
  if (!title) return { main: tab.target.name ?? shellName(tab.shell) };
  return { main: titlePath(title) ?? title };
}
