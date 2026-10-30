import { invoke } from "@tauri-apps/api/core";

/** A kind of local terminal: the login shell, or on Windows PowerShell, cmd, WSL… */
export interface LocalProfile {
  id: string;
  name: string;
  detail: string | null;
}

/** Means "whatever the default profile is" until the list has loaded. */
export const DEFAULT_PROFILE = "default";

export const listProfiles = () => invoke<LocalProfile[]>("local_profiles");
