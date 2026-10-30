import { useEffect, useRef } from "react";

interface Props {
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  /** Which edge of the window the panel sits on. */
  side?: "left" | "right";
  label: string;
  onChange(width: number): void;
  /** Called once a drag or a keyboard change is over, to save the width. */
  onCommit(width: number): void;
}

const KEY_STEP = 16;

/** The draggable edge between a side panel and the terminals. */
export function Splitter({ width, min, max, defaultWidth, side = "left", label, onChange, onCommit }: Props) {
  const dragging = useRef(false);
  const latest = useRef(width);
  latest.current = width;

  const clamp = (value: number) => Math.round(Math.min(max, Math.max(min, value)));

  useEffect(() => () => document.body.classList.remove("resizing"), []);

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      style={{ left: side === "left" ? width : `calc(100% - ${width}px)` }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragging.current = true;
        document.body.classList.add("resizing");
      }}
      onPointerMove={(e) => {
        if (dragging.current) onChange(clamp(side === "left" ? e.clientX : window.innerWidth - e.clientX));
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove("resizing");
        onCommit(latest.current);
      }}
      onDoubleClick={() => {
        onChange(defaultWidth);
        onCommit(defaultWidth);
      }}
      onKeyDown={(e) => {
        const outward = side === "left" ? "ArrowRight" : "ArrowLeft";
        const inward = side === "left" ? "ArrowLeft" : "ArrowRight";
        const step = e.key === inward ? -KEY_STEP : e.key === outward ? KEY_STEP : 0;
        if (!step) return;
        e.preventDefault();
        const next = clamp(width + step);
        onChange(next);
        onCommit(next);
      }}
    />
  );
}
