import { useRef, useState } from "react";
import { useLocale } from "./locale";

interface Props { label: string; controls: string; value: number; min: number; max: number;
  onChange: (value: number) => void; onReset: () => void; className?: string }

export function PaneResizeHandle({ label, controls, value, min, max, onChange, onReset, className = "" }: Props) {
  const { t } = useLocale();
  const start = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const change = (next: number) => onChange(Math.max(min, Math.min(max, next)));
  function endDrag() { start.current = null; setDragging(false); }
  return <div role="separator" tabIndex={0} aria-orientation="vertical" aria-label={label} aria-controls={controls}
    aria-valuemin={Math.round(min)} aria-valuemax={Math.round(max)} aria-valuenow={Math.round(value)}
    aria-valuetext={t(`${Math.round(value)} 像素`, `${Math.round(value)} pixels`)}
    title={t("拖动调整宽度 · 双击恢复自动布局 · 方向键微调", "Drag or use the arrow keys to resize. Double-click to reset.")}
    className={`knowledge-resize-handle ${className}`} data-dragging={dragging || undefined}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      start.current = { x: event.clientX, width: value }; setDragging(true);
    }}
    onPointerMove={(event) => { if (start.current) change(start.current.width + event.clientX - start.current.x); }}
    onPointerUp={(event) => { endDrag(); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onLostPointerCapture={endDrag} onPointerCancel={endDrag} onDoubleClick={onReset}
    onKeyDown={(event) => {
      const step = event.shiftKey ? 30 : 10;
      if (event.key === "ArrowLeft") change(value - step);
      else if (event.key === "ArrowRight") change(value + step);
      else if (event.key === "Home") change(min);
      else if (event.key === "End") change(max);
      else if (event.key === "Enter") onReset();
      else return;
      event.preventDefault();
    }} />;
}
