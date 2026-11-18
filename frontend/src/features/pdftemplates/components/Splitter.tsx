import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

export interface SplitterProps {
  side: 'left' | 'right';
  /** Committed width of the pane it resizes, in px. */
  width: number;
  min: number;
  max: number;
  defaultWidth: number;
  label: string;
  /** Live width while dragging (the page sets a CSS variable; nothing re-renders). */
  onDrag: (px: number) => void;
  /** The final width, to remember. */
  onCommit: (px: number) => void;
}

const STEP = 16;

/**
 * Draggable edge between two panes. Carbon has no splitter/resizer component, so this is a small handwritten WAI-ARIA
 * window splitter: pointer drag, arrow keys (16 px), double-click resets to the default width.
 */
export function Splitter({ side, width, min, max, defaultWidth, label, onDrag, onCommit }: SplitterProps) {
  const dragging = useRef(false);
  const last = useRef(width);
  const clamp = (px: number) => Math.round(Math.min(max, Math.max(min, px)));

  const widthAt = (event: PointerEvent<HTMLDivElement>) => {
    const work = event.currentTarget.parentElement!.getBoundingClientRect();
    return clamp(side === 'left' ? event.clientX - work.left : work.right - event.clientX);
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = true;
    last.current = width;
    document.body.classList.add('pdft-resizing');
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    last.current = widthAt(event);
    onDrag(last.current);
  };
  const end = () => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.classList.remove('pdft-resizing');
    onCommit(last.current);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (event.key !== grow && event.key !== shrink) return;
    event.preventDefault();
    const next = clamp(width + (event.key === grow ? STEP : -STEP));
    onDrag(next);
    onCommit(next);
  };

  return (
    // A focusable separator is the WAI-ARIA window splitter pattern; the lint rule only knows static separators.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      className={`pdft-splitter pdft-splitter--${side}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => {
        onDrag(defaultWidth);
        onCommit(defaultWidth);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
