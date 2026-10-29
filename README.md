# Chappe

A terminal and SSH client for macOS, Linux and Windows.
Tauri 2 and React for the interface, Rust for everything that touches the system.

Named after Claude Chappe, who built the optical telegraph: the first network
for sending messages over long distances, tower to tower.

## Requirements

- Rust stable: `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh`
- Node.js 20 or later
- macOS: the Xcode command line tools (`xcode-select --install`)
- Linux: the WebKitGTK packages listed at https://v2.tauri.app/start/prerequisites/

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

## Sessions

The + button in the tab bar, or ⌘T (Ctrl+Shift+T elsewhere), opens the session
palette: every local shell and server in one searchable list, the most recently
used first. Type a few letters of a name or an address, then press Enter. The
first nine entries also open with ⌘1…⌘9 (Alt+1…Alt+9 elsewhere).

Typing `user@host:port` connects to a server that isn't saved. ⌘E (Ctrl+E)
edits the selected server, and "Add a server…" closes the list.

Right-clicking a tab offers Close, Close Others, Close Tabs to the Right, Close
Tabs to the Left and Close All. Editors with unsaved changes among them ask
first; a middle-click closes a tab.

## Files

The panel on the left follows the active tab: the files of this computer for a
local shell, the server's files over SFTP for an SSH tab. SFTP runs on the
tab's own connection, so it never asks for a password again.

- Double-click or Enter opens a folder, or a text file in the editor. Other
  files open in their default app (remote ones from a temporary copy, so
  changes made there are not sent back).
- Right-click for download, upload, rename, delete, copy path and "Open in
  terminal", which `cd`s the shell there.
- Drop files from the Finder or Explorer onto the panel to upload them.
- The target button takes the panel to the shell's current folder. Shells that
  report their folder (OSC 7) are followed automatically.
- Local deletes go to the Trash. Remote deletes are permanent and ask first.
- ⌘B (Ctrl+Shift+B) shows or hides the panel; its edge can be dragged.

## Find in the terminal

⌘F (Ctrl+Shift+F elsewhere) opens a find bar over the terminal; it searches
the output and the whole scrollback, from the latest output up. Matches are
highlighted as you type, with their count and marks in the scrollbar. Enter
(or ⌘G) goes up to older matches, Shift+Enter (or ⇧⌘G) back down; Aa, ab and .* switch on match case, whole
word and regular expressions; Esc closes the bar. A one-line selection becomes
the search.

## Editor

Text files open in an editor tab: double-click one in the file panel, or
right-click it and choose Edit. Images, PDFs, archives and other binary files
open in their default app instead.

- Remote files are read and saved over SFTP, on the tab's connection.
- ⌘S (Ctrl+S) saves. If the file changed on disk or on the server since it was
  opened, Chappe asks before replacing it.
- ⌘F (Ctrl+F) finds and replaces; ⌘⌥G (Ctrl+Alt+G) goes to a line.
- Syntax highlighting follows the file name, for about a hundred languages.
- Line endings (LF or CRLF) and a UTF-8 byte order mark are kept as they were.
- Closing a tab or quitting with unsaved changes asks first.
- Files up to 5 MB, in UTF-8.

## History

The panel on the right lists the commands run in the active terminal tab.

- Commands are read from the screen when Enter is pressed, so lines recalled
  with ↑ or completed with Tab are listed as they ran. Nothing needs to be set
  up in the shell. Shells that mark their prompts (OSC 133, from iTerm2 or
  VS Code shell integration) are followed exactly.
- Left out: full-screen programs (vim, less, top), input a program doesn't
  echo (passwords), lines typed for a program rather than the shell, and
  commands starting with a space.
- "Before this session" lists the last 20 commands the shell ran earlier, read
  from its own history file (zsh, bash, fish, PowerShell); "Load more" reads
  older ones. Over SSH the file is read on a
  separate channel of the tab's connection: nothing appears in the terminal.
- Click to select, double-click or ⌘↵ (Ctrl+↵) to run, Enter to insert in the
  terminal without running. A command isn't run over something already typed.
- The history lives in memory only: it is never written to disk, and goes
  away with the tab.
- ⇧⌘H (Ctrl+Shift+H) shows or hides the panel; its edge can be dragged.

## Settings

⌘, (Ctrl+, elsewhere), the cog in the status bar, or Chappe › Settings… on
macOS opens the settings tab. Changes apply right away to every open terminal
and editor, and are saved in `settings.json` in the app's config folder.

- Theme: Chappe Dark and Light, Solarized Dark and Light, Dracula, Nord,
  Gruvbox Dark, One Dark, Tokyo Night, Catppuccin Mocha and Latte. A theme
  colours the terminals, the editor and the whole interface.
- Terminal font: JetBrains Mono, Fira Code, Source Code Pro and IBM Plex Mono
  are included; common monospace fonts installed on the computer are listed
  too, and any other installed font can be typed in. Installed Nerd Fonts fill
  in the icons a font lacks.
- Interface font (Barlow Semi Condensed, Inter, the system font or an
  installed one) and text size. Paths and commands in the panels use the
  terminal font.
- Font size, line height, cursor shape and blinking (new tabs), scrollback.
- Editor font size.

## Shortcuts

| Action | macOS | Linux / Windows |
| --- | --- | --- |
| New session | ⌘T | Ctrl+Shift+T |
| Show or hide files | ⌘B | Ctrl+Shift+B |
| Show or hide history | ⇧⌘H | Ctrl+Shift+H |
| Settings | ⌘, | Ctrl+, |
| Find in terminal | ⌘F | Ctrl+Shift+F |
| Save (editor) | ⌘S | Ctrl+S |
| Find (editor) | ⌘F | Ctrl+F |
| Close tab | ⌘W | Ctrl+Shift+W |
| Next / previous tab | ⌘⇧] / ⌘⇧[ or Ctrl+Tab | Ctrl+PgDn / Ctrl+PgUp or Ctrl+Tab |
| Go to tab 1 to 9 | ⌘1 … ⌘9 | |
| Copy / paste | ⌘C / ⌘V | Ctrl+Shift+C / Ctrl+Shift+V |
| Open a link | ⌘-click | Ctrl-click |

In the file list: arrows to move, Enter to open, Backspace for the parent
folder, F2 to rename, Delete (⌘⌫ on macOS) to delete, and typing jumps to a name.

On Windows, Ctrl+C also copies when text is selected (and interrupts when
nothing is), and Ctrl+V pastes, as in Windows Terminal.

## Local terminals

On macOS and Linux, a local tab runs your login shell, so `.zprofile`,
`.zshrc` or `.bash_profile` load as they would in any terminal.

On Windows, the session palette lists PowerShell 7 (when installed), Windows
PowerShell, Command Prompt and every WSL distribution. The first one is the
default for new tabs.

## SSH

The session palette lists two kinds of servers:

- **Saved servers**, added with the + button. They are stored in
  `servers.json` in the app's config folder
  (`~/Library/Application Support/dev.chappe.app/` on macOS).
- **Hosts from `~/.ssh/config`**, read live. `HostName`, `User`, `Port`,
  `IdentityFile`, `ProxyJump` and `Include` are honoured; `Host *` blocks
  provide defaults and are not listed. Edit one to save a copy you can change.

Authentication follows `ssh`: the SSH agent, then key files, then
keyboard-interactive and password. Encrypted keys ask for their passphrase.
Passwords can be remembered in the macOS Keychain, the Windows Credential
Manager or the Linux keyring; they are never written to `servers.json`.

Host keys are checked against `~/.ssh/known_hosts` (hashed entries, wildcards
and `@revoked` included). A new host asks for confirmation and is added to the
file; a changed key refuses the connection and says how to fix it.


## Releases and updates

Chappe updates itself with the Tauri updater: it looks for a new version a
few seconds after launch and every six hours (Settings › Updates can turn this
off or check now). A newer version shows "Update to x.y.z" in the status bar;
installing it downloads the new build, checks its signature and restarts the
app. Updates come from the latest published release of
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

```
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

## Roadmap

1. ~~Skeleton, tabs, local terminal~~
2. ~~SSH connections and server book~~
3. ~~Session palette and file panel (local and SFTP)~~
4. ~~Text editor for local and remote files~~
5. ~~Command history panel~~
6. ~~Settings: themes and fonts~~
7. ~~Automatic updates~~
8. Tunnels and port forwarding
9. Profiles: custom shells, startup commands
