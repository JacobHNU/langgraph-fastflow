import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export function ResizableHandle({
  name,
  target,
  variable,
  axis = 'x',
  reverse = false,
  min,
  max,
  reserve,
}: {
  name: string;
  target: string;
  variable: string;
  axis?: 'x' | 'y';
  reverse?: boolean;
  min: number;
  max: number;
  reserve: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; size: number } | null>(null);
  const [size, setSize] = useState(min);
  const [limit, setLimit] = useState(max);
  const key = `workflow-panel:${variable}`;
  const dimension = axis === 'x' ? 'width' : 'height';
  const bounds = () =>
    Math.max(
      min,
      Math.min(
        max,
        (ref.current?.parentElement?.getBoundingClientRect()[dimension] ?? max) - reserve,
      ),
    );
  const current = () =>
    ref.current?.parentElement?.querySelector(target)?.getBoundingClientRect()[dimension] ?? min;
  const resize = (value: number) => {
    const next = Math.round(Math.max(min, Math.min(bounds(), value)));
    ref.current?.parentElement?.style.setProperty(variable, `${next}px`);
    setSize(next);
    try {
      localStorage.setItem(key, String(next));
    } catch {
      /* Storage can be disabled. */
    }
  };
  const reset = () => {
    ref.current?.parentElement?.style.removeProperty(variable);
    try {
      localStorage.removeItem(key);
    } catch {
      /* Storage can be disabled. */
    }
  };
  useEffect(() => {
    const parent = ref.current?.parentElement;
    const panel = parent?.querySelector(target);
    if (!parent || !panel) return;
    try {
      const saved = Number(localStorage.getItem(key));
      if (saved >= min && saved <= max) parent.style.setProperty(variable, `${saved}px`);
    } catch {
      /* Use the default layout when storage is disabled. */
    }
    const observer = new ResizeObserver(() => {
      setSize(Math.round(panel.getBoundingClientRect()[dimension]));
      setLimit(Math.max(min, Math.min(max, parent.getBoundingClientRect()[dimension] - reserve)));
    });
    observer.observe(parent);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [key, target, variable, dimension, min, max, reserve]);
  const coordinate = (e: PointerEvent) => (axis === 'x' ? e.clientX : e.clientY);
  const keyboard = (e: KeyboardEvent) => {
    if (e.key === 'Home' || e.key === 'Enter') {
      e.preventDefault();
      reset();
      return;
    }
    const decrease = axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const increase = axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    if (e.key !== decrease && e.key !== increase) return;
    e.preventDefault();
    resize(current() + (e.key === increase ? 1 : -1) * (reverse ? -1 : 1) * (e.shiftKey ? 40 : 10));
  };
  return (
    <div
      ref={ref}
      className={`resize-handle resize-${axis} resize-${target.slice(1)}`}
      role="separator"
      tabIndex={0}
      aria-label={name}
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuemin={min}
      aria-valuemax={limit}
      aria-valuenow={size}
      title={`${name}；双击恢复默认`}
      onKeyDown={keyboard}
      onDoubleClick={reset}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        drag.current = { start: coordinate(e), size: current() };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.dataset.dragging = 'true';
      }}
      onPointerMove={(e) => {
        if (drag.current)
          resize(drag.current.size + (coordinate(e) - drag.current.start) * (reverse ? -1 : 1));
      }}
      onPointerUp={(e) => {
        drag.current = null;
        delete e.currentTarget.dataset.dragging;
        if (e.currentTarget.hasPointerCapture(e.pointerId))
          e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onLostPointerCapture={(e) => {
        drag.current = null;
        delete e.currentTarget.dataset.dragging;
      }}
      onPointerCancel={(e) => {
        drag.current = null;
        delete e.currentTarget.dataset.dragging;
      }}
    >
      <span />
    </div>
  );
}
