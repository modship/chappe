# Developing Chappe

Tauri 2 and React for the interface, Rust for everything that touches the system.

## Requirements

- Rust stable: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Node.js 20 or later
- macOS: the Xcode command line tools (`xcode-select --install`)
- Linux: the WebKitGTK packages listed at <https://v2.tauri.app/start/prerequisites/>

## Run

```sh
npm install
npm run tauri dev
```

The first run compiles every Rust dependency and takes a few minutes.

## Build the app

```sh
npm run tauri build
```

The `.app` and `.dmg` land in `src-tauri/target/release/bundle/`.

## Releases and updates

Chappe updates itself with the Tauri updater. Updates come from the latest
published release of
[Modship/chappe](https://github.com/Modship/chappe/releases), which must be
public for the app to download them.

### One-time setup

1. Generate the signing key pair, and keep the private key and its password
   somewhere safe: without them no update can ever be published again.

   ```sh
   npm run tauri signer generate -- -w ~/.tauri/chappe.key
   ```

2. Put the public key (the content of `~/.tauri/chappe.key.pub`) in
   `src-tauri/tauri.conf.json`, under `plugins.updater.pubkey`. Builds without
   it don't offer updates.
3. In the GitHub repository, add two Actions secrets:
   `TAURI_SIGNING_PRIVATE_KEY` (the content of `~/.tauri/chappe.key`) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

### Publishing a version

1. Set the version everywhere it lives (`package.json`, `package-lock.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `Cargo.lock`):
   `npm run version:set 0.3.0`.
2. Commit, tag and push, as the script suggests:
   `git commit -am "Release v0.3.0" && git tag v0.3.0 && git push && git push --tags`.
3. The Release workflow builds and signs the installers for macOS (Apple
   silicon and Intel), Linux and Windows, and attaches them to a draft release
   with `latest.json`.
4. Edit the draft's notes (the app shows them) and publish it. Installed apps
   find the update from then on.

The updater replaces the app itself on macOS, the AppImage on Linux and the
installed app on Windows. Linux .deb and .rpm installs update through their
package manager instead. macOS builds aren't signed with an Apple Developer ID
yet, so the first install needs right-click › Open.

Signed update artifacts are only built with `src-tauri/tauri.release.conf.json`
(`npm run tauri build -- --config src-tauri/tauri.release.conf.json`), so
ordinary builds don't need the private key.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on pull requests,
on macOS, Linux and Windows: type-check, `cargo fmt`, `clippy` with warnings
as errors, `cargo test`, then a release build. The installers (`.dmg`, `.msi`
and `.exe`, `.deb`, `.rpm`, `.AppImage`) are attached to each run as artifacts.

The builds are not signed yet: macOS and Windows warn before opening them.

## Architecture

```text
src-tauri/src/
  session.rs       sessions shared by local and SSH tabs: write, resize, close, prompts
  output.rs        output pump: binary channel, batched during floods
  local.rs         local shells in a pseudo-terminal: login shell, PowerShell, cmd, WSL
  ssh/mod.rs       SSH with russh: jump hosts, authentication, shell
  ssh/known_hosts.rs  host key verification
  servers.rs       server book, ~/.ssh/config import, credential store
  files.rs         file panel and editor: local disk and SFTP, transfers
  history.rs       earlier commands from the shell's history file, local or remote
  settings.rs      settings.json storage
  updates.rs       whether the build can verify updates
  menu.rs          native menu bar (macOS)
src/
  lib/session.ts   client for sessions (ordered input queue, events)
  lib/servers.ts   server book API
  lib/local.ts     local shell profiles
  lib/files.ts     file panel API and path helpers
  lib/fuzzy.ts     fuzzy matching for the session palette
  lib/editor.ts    editor file API; lib/editorTheme.ts its CodeMirror theme
  lib/settings.ts  settings, defaults, fonts
  lib/themes.ts    themes and the interface colours derived from them
  lib/updates.ts   update checks and installation
  lib/commandCapture.ts  reads the commands typed in a terminal
  lib/history.ts   in-memory command history per tab
  components/      session palette, file and history panels, editor, tabs, terminal, dialogs
```
