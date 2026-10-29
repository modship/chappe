import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type MenuItem =
  | { label: string; onSelect(): void; danger?: boolean; disabled?: boolean; hint?: string }
  | "separator";

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose(): void;
}

/** A right-click menu, kept inside the window and usable from the keyboard. */
/** Drops separators at the ends and in a row, left by items that don't apply. */
function tidy(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (item === "separator" && (out.length === 0 || out[out.length - 1] === "separator")) continue;
    out.push(item);
  }
  while (out[out.length - 1] === "separator") out.pop();
  return out;
}

export function ContextMenu({ x, y, items: given, onClose }: Props) {
  const items = tidy(given);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const actionable = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item !== "separator" && !item.disabled);
  const [focus, setFocus] = useState(0);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
    menu.focus();
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", close, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("mousedown", close, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const run = (item: MenuItem) => {
    if (item === "separator" || item.disabled) return;
    onClose();
    item.onSelect();
  };

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={position}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
        else if (e.key === "ArrowDown") setFocus((f) => (f + 1) % actionable.length);
        else if (e.key === "ArrowUp") setFocus((f) => (f - 1 + actionable.length) % actionable.length);
        else if (e.key === "Enter") run(actionable[focus]?.item);
        else return;
        e.preventDefault();
      }}
    >
      {items.map((item, index) =>
        item === "separator" ? (
          <div key={index} className="context-separator" role="separator" />
        ) : (
          <button
            key={index}
            type="button"
            role="menuitem"
            className="context-item"
            data-danger={item.danger}
            data-focused={actionable[focus]?.index === index}
            disabled={item.disabled}
            onMouseEnter={() => setFocus(actionable.findIndex((a) => a.index === index))}
            onClick={() => run(item)}
          >
            <span>{item.label}</span>
            {item.hint && <kbd>{item.hint}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
