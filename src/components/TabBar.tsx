import { useState } from "react";
import type { Tab } from "../App";
import { shortcutLabel } from "../lib/shortcuts";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { tabLabel } from "../lib/title";
import { GearIcon } from "./GearIcon";

interface Props {
  tabs: Tab[];
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  onCloseMany(ids: string[]): void;
  onNew(): void;
}

// No native tooltips on tabs: WebKit shows them over the tab menu. The status
// bar has a tab's full path or address.
export function TabBar({ tabs, activeId, onSelect, onClose, onCloseMany, onNew }: Props) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const tabMenu = (tab: Tab): MenuItem[] => {
    const index = tabs.indexOf(tab);
    const ids = (list: Tab[]) => list.map((t) => t.id);
    const others = ids(tabs.filter((t) => t !== tab));
    const right = ids(tabs.slice(index + 1));
    const left = ids(tabs.slice(0, index));
    return [
      { label: "Close", onSelect: () => onClose(tab.id), hint: shortcutLabel.closeTab },
      { label: "Close Others", onSelect: () => onCloseMany(others), disabled: !others.length },
      { label: "Close Tabs to the Right", onSelect: () => onCloseMany(right), disabled: !right.length },
      { label: "Close Tabs to the Left", onSelect: () => onCloseMany(left), disabled: !left.length },
      "separator",
      { label: "Close All", onSelect: () => onCloseMany(ids(tabs)) },
    ];
  };

  return (
    <div className="tabbar" data-tauri-drag-region>
      <div className="tabs" role="tablist" aria-label="Open terminals">
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          const label = tabLabel(tab);
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className="tab"
              data-active={active}
              data-state={tab.state}
              data-remote={tab.target.kind === "ssh"}
              data-dirty={Boolean(tab.dirty)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(tab.id);
                }
              }}
              onClick={() => onSelect(tab.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, items: tabMenu(tab) });
              }}
            >
              {tab.target.kind === "ssh" && <span className="tab-dot" aria-hidden="true" />}
              {tab.target.kind === "settings" && <GearIcon className="tab-file" />}
              {tab.target.kind === "editor" && (
                <svg className="tab-file" width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3.5 1.8h5.6l3.4 3.4v9H3.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                  <path d="M9 1.8v3.5h3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
              )}
              <span className="tab-label">
                {label.main}
                {label.detail && <span className="tab-detail">{label.detail}</span>}
              </span>
              <button
                type="button"
                className="tab-close"
                aria-label={tab.dirty ? "Close tab (unsaved changes)" : "Close tab"}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <svg className="close-x" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                  <path d="M2 2l6 6M8 2L2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <span className="dirty-dot" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="tab-new"
        aria-label="New session"
        title={`New session (${shortcutLabel.newSession})`}
        onClick={onNew}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 1.5v9M1.5 6h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
