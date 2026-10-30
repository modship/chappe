import { useEffect, useRef, useState, type FormEvent } from "react";
import { open as openFile } from "@tauri-apps/plugin-dialog";
import { homeDir, join } from "@tauri-apps/api/path";
import {
  credentialStoreName,
  deleteServer,
  forgetPassword,
  saveServer,
  type AuthMethod,
  type ServerEntry,
} from "../lib/servers";

interface Props {
  /** The server to edit; a `sshConfig` entry is saved as a new server. */
  server: ServerEntry | null;
  servers: ServerEntry[];
  onDone(saved: ServerEntry | null): void;
  onCancel(): void;
}

const authOptions: { value: AuthMethod; label: string; help: string }[] = [
  {
    value: "auto",
    label: "Automatic",
    help: "Tries your SSH agent and the keys in ~/.ssh, then asks for a password.",
  },
  { value: "key", label: "Key file", help: "Uses this private key only." },
  {
    value: "password",
    label: "Password",
    help: "Skips keys. Leave the password empty to be asked each time.",
  },
];

export function ServerDialog({ server, servers, onDone, onCancel }: Props) {
  const editing = server?.source === "saved";
  const [name, setName] = useState(server?.name ?? "");
  const [host, setHost] = useState(server?.host ?? "");
  const [port, setPort] = useState(String(server?.port ?? 22));
  const [user, setUser] = useState(server?.user ?? "");
  const [auth, setAuth] = useState<AuthMethod>(server?.auth ?? "auto");
  const [keyPath, setKeyPath] = useState(server?.keyPath ?? "");
  const [password, setPassword] = useState("");
  const [hasPassword, setHasPassword] = useState(editing && server.hasPassword);
  const [jump, setJump] = useState(server?.jump ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => firstField.current?.focus(), []);

  const jumpChoices = servers.filter((s) => s.id !== server?.id || !editing);
  const jumpIsKnown = !jump || jumpChoices.some((s) => s.id === jump);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const portNumber = Number(port);
    if (!host.trim()) return setError("Enter a host name or IP address.");
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
      return setError("Enter a port between 1 and 65535.");
    }
    if (auth === "key" && !keyPath.trim()) return setError("Choose a key file.");
    setBusy(true);
    setError(null);
    try {
      const saved = await saveServer(
        {
          id: editing ? server.id : "",
          name: name.trim() || host.trim(),
          host: host.trim(),
          port: portNumber,
          user: user.trim() || null,
          auth,
          keyPath: auth === "password" ? null : keyPath.trim() || null,
          jump: jump || null,
        },
        auth === "password" ? password : undefined,
      );
      onDone(saved);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const browse = async () => {
    const sshDir = await join(await homeDir(), ".ssh");
    const picked = await openFile({ title: "Choose a private key", defaultPath: sshDir, multiple: false });
    if (typeof picked === "string") setKeyPath(picked);
  };

  const remove = async () => {
    if (!editing) return;
    if (!confirmDelete) return setConfirmDelete(true);
    setBusy(true);
    try {
      await deleteServer(server.id);
      onDone(null);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!editing) return;
    await forgetPassword(server.id);
    setHasPassword(false);
  };

  const title = editing ? "Edit server" : server ? `Save ${server.name} as a server` : "Add a server";

  return (
    <div className="modal-layer" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="server-dialog-title"
        onSubmit={submit}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <h2 id="server-dialog-title">{title}</h2>

        <div className="field-row">
          <label className="field field-grow">
            <span className="field-label">Host</span>
            <input
              ref={firstField}
              value={host}
              placeholder="example.com or 192.168.1.20"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setHost(e.target.value)}
            />
          </label>
          <label className="field field-port">
            <span className="field-label">Port</span>
            <input value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value)} />
          </label>
        </div>

        <label className="field">
          <span className="field-label">User</span>
          <input
            value={user}
            placeholder="Same as on this computer"
            spellCheck={false}
            autoCapitalize="off"
            onChange={(e) => setUser(e.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">Name</span>
          <input
            value={name}
            placeholder={host.trim() || "Shown in the sidebar"}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        <fieldset className="field">
          <legend className="field-label">Authentication</legend>
          <div className="segmented" role="radiogroup">
            {authOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={auth === option.value}
                className="segment"
                onClick={() => setAuth(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="field-help">{authOptions.find((o) => o.value === auth)!.help}</p>
        </fieldset>

        {auth !== "password" && (
          <div className="field-row">
            <label className="field field-grow">
              <span className="field-label">{auth === "key" ? "Key file" : "Key file (optional)"}</span>
              <input
                value={keyPath}
                placeholder="~/.ssh/id_ed25519"
                spellCheck={false}
                onChange={(e) => setKeyPath(e.target.value)}
              />
            </label>
            <button type="button" className="button-quiet field-side" onClick={browse}>
              Browse…
            </button>
          </div>
        )}

        {auth === "password" &&
          (hasPassword ? (
            <p className="field-help field-inline">
              A password is saved in {credentialStoreName}.
              <button type="button" className="link-button" onClick={forget}>
                Forget it
              </button>
            </p>
          ) : (
            <label className="field">
              <span className="field-label">Password</span>
              <input
                type="password"
                value={password}
                autoComplete="off"
                placeholder="Ask when connecting"
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          ))}

        <label className="field">
          <span className="field-label">Jump host</span>
          <select value={jump} onChange={(e) => setJump(e.target.value)}>
            <option value="">None, connect directly</option>
            {!jumpIsKnown && <option value={jump}>{jump}</option>}
            {jumpChoices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal-actions">
          {editing && (
            <button type="button" className="button-danger" disabled={busy} onClick={remove}>
              {confirmDelete ? "Click again to delete" : "Delete"}
            </button>
          )}
          <span className="modal-spacer" />
          <button type="button" className="button-quiet" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button-primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </div>
  );
}
