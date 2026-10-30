import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Prompt, PromptReply } from "../lib/session";
import { credentialStoreName } from "../lib/servers";

interface Props {
  prompt: Prompt;
  onReply(reply: PromptReply | null): void;
}

/** A question the connection needs answered, shown over its terminal. */
export function PromptCard({ prompt, onReply }: Props) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const first = formRef.current?.querySelector<HTMLElement>("input, button[type=submit]");
    first?.focus();
  }, [prompt]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onReply(null);
    }
  };

  return (
    <div className="prompt-layer">
      <form
        ref={formRef}
        className="prompt-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-title"
        onKeyDown={onKeyDown}
        onSubmit={(e) => e.preventDefault()}
      >
        {prompt.kind === "hostKey" && <HostKey prompt={prompt} onReply={onReply} />}
        {prompt.kind === "password" && <Password prompt={prompt} onReply={onReply} />}
        {prompt.kind === "passphrase" && <Passphrase prompt={prompt} onReply={onReply} />}
        {prompt.kind === "keyboardInteractive" && <Interactive prompt={prompt} onReply={onReply} />}
      </form>
    </div>
  );
}

type PartProps<K extends Prompt["kind"]> = {
  prompt: Extract<Prompt, { kind: K }>;
  onReply(reply: PromptReply | null): void;
};

function HostKey({ prompt, onReply }: PartProps<"hostKey">) {
  const where = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;
  return (
    <>
      <h2 id="prompt-title">Trust this host?</h2>
      <p>
        This is your first connection to <strong>{where}</strong>. Check that the fingerprint
        matches the server's before you trust it.
      </p>
      <div className="fingerprint">
        <span className="fingerprint-algo">{prompt.algorithm}</span>
        <code>{prompt.fingerprint}</code>
      </div>
      <p className="prompt-note">Chappe will remember it in ~/.ssh/known_hosts, like ssh does.</p>
      <div className="prompt-actions">
        <button type="button" className="button-quiet" onClick={() => onReply(null)}>
          Cancel
        </button>
        <button
          type="submit"
          className="button-primary"
          onClick={() => onReply({ kind: "hostKey", accept: true })}
        >
          Trust and connect
        </button>
      </div>
    </>
  );
}

function SecretForm({
  title,
  body,
  error,
  label,
  canRemember,
  onReply,
}: {
  title: string;
  body?: string;
  error?: string;
  label: string;
  canRemember: boolean;
  onReply(reply: PromptReply | null): void;
}) {
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onReply({ kind: "secret", value, remember });
  };
  return (
    <>
      <h2 id="prompt-title">{title}</h2>
      {body && <p>{body}</p>}
      {error && (
        <p className="prompt-error" role="alert">
          {error}
        </p>
      )}
      <label className="field">
        <span className="field-label">{label}</span>
        <input
          type="password"
          value={value}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit(e)}
        />
      </label>
      {canRemember && (
        <label className="check">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember in {credentialStoreName}
        </label>
      )}
      <div className="prompt-actions">
        <button type="button" className="button-quiet" onClick={() => onReply(null)}>
          Cancel
        </button>
        <button type="submit" className="button-primary" onClick={submit}>
          Connect
        </button>
      </div>
    </>
  );
}

function Password({ prompt, onReply }: PartProps<"password">) {
  return (
    <SecretForm
      key={String(prompt.retry)}
      title={`Password for ${prompt.user}@${prompt.host}`}
      error={prompt.retry ? "That password was refused. Try again." : undefined}
      label="Password"
      canRemember={prompt.canRemember}
      onReply={onReply}
    />
  );
}

function Passphrase({ prompt, onReply }: PartProps<"passphrase">) {
  return (
    <SecretForm
      key={String(prompt.retry)}
      title="Unlock your key"
      body={prompt.keyPath}
      error={prompt.retry ? "Wrong passphrase. Try again." : undefined}
      label="Passphrase"
      canRemember={false}
      onReply={onReply}
    />
  );
}

function Interactive({ prompt, onReply }: PartProps<"keyboardInteractive">) {
  const [values, setValues] = useState(() => prompt.fields.map(() => ""));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onReply({ kind: "answers", values });
  };
  return (
    <>
      <h2 id="prompt-title">{prompt.name || `${prompt.user}@${prompt.host}`}</h2>
      {prompt.instructions && <p className="prompt-pre">{prompt.instructions}</p>}
      {prompt.fields.map((field, i) => (
        <label className="field" key={i}>
          <span className="field-label">{field.label.replace(/:\s*$/, "")}</span>
          <input
            type={field.echo ? "text" : "password"}
            value={values[i]}
            autoComplete="one-time-code"
            spellCheck={false}
            onChange={(e) => setValues((v) => v.map((old, j) => (j === i ? e.target.value : old)))}
            onKeyDown={(e) => e.key === "Enter" && i === prompt.fields.length - 1 && submit(e)}
          />
        </label>
      ))}
      <div className="prompt-actions">
        <button type="button" className="button-quiet" onClick={() => onReply(null)}>
          Cancel
        </button>
        <button type="submit" className="button-primary" onClick={submit}>
          Continue
        </button>
      </div>
    </>
  );
}
