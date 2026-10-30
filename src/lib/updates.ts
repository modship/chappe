import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

/** First automatic check after launch, then this often while the app runs. */
export const FIRST_CHECK_DELAY = 5_000;
export const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export const appVersion = () => getVersion();

/** Whether this build has a public key to verify updates with. */
export const updatesConfigured = () => invoke<boolean>("updates_configured").catch(() => false);

/** The newer version on offer, or null when this one is the latest. */
export async function checkForUpdate(): Promise<Update | null> {
  return check({ timeout: 30_000 });
}

export interface Progress {
  downloaded: number;
  /** Unknown when the server doesn't say. */
  total: number | null;
}

/** Downloads, verifies and installs the update, then restarts the app. */
export async function installUpdate(update: Update, onProgress: (progress: Progress) => void): Promise<void> {
  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") total = event.data.contentLength ?? null;
    else if (event.event === "Progress") downloaded += event.data.chunkLength;
    onProgress({ downloaded, total });
  });
  // On Windows the installer has already closed the app by now.
  await relaunch();
}

/** Plain words for what went wrong while checking or installing. */
export function updateError(error: unknown): string {
  const text = String(error);
  if (/signature/i.test(text)) return "The update's signature doesn't match: it wasn't installed.";
  // GitHub answers 404 for a draft release and for a private repository.
  if (/404|not found|valid release JSON/i.test(text)) {
    return "No published release found. Releases must be published (not drafts), in a public repository.";
  }
  if (/network|dns|connect|timed? ?out|request/i.test(text)) return "Couldn't reach the update server. Check your connection.";
  return `The update failed: ${text}`;
}
