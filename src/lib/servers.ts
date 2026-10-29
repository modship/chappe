import { invoke } from "@tauri-apps/api/core";
import { platform } from "./platform";

export type AuthMethod = "auto" | "key" | "password";

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  user?: string | null;
  auth: AuthMethod;
  keyPath?: string | null;
  /** A server id, or an OpenSSH ProxyJump value for imported hosts. */
  jump?: string | null;
}

export interface ServerEntry extends Server {
  source: "saved" | "sshConfig";
  hasPassword: boolean;
}

export interface ServerList {
  servers: ServerEntry[];
  configError: string | null;
}

export const listServers = () => invoke<ServerList>("servers_list");

export const saveServer = (server: Server, password?: string) =>
  invoke<ServerEntry>("server_save", { server, password: password || null });

export const deleteServer = (id: string) => invoke<void>("server_delete", { id });

export const forgetPassword = (id: string) => invoke<void>("server_forget_password", { id });

export function serverAddress(server: Server): string {
  const user = server.user ? `${server.user}@` : "";
  const port = server.port && server.port !== 22 ? `:${server.port}` : "";
  return `${user}${server.host}${port}`;
}

/** Where passwords go, in the words of each platform. */
export const credentialStoreName =
  platform === "mac" ? "Keychain" : platform === "windows" ? "Credential Manager" : "the keyring";
