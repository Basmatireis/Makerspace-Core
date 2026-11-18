import { useCallback, useRef, useState } from 'react';

export type PaneSide = 'left' | 'right';
export const PANES: Record<PaneSide, { def: number; min: number; max: number; css: string }> = {
  left: { def: 300, min: 220, max: 560, css: '--pdft-left' },
  right: { def: 320, min: 260, max: 600, css: '--pdft-right' },
};
const STORAGE_KEY = 'pdfTemplateEditorWidths';

const clamp = (side: PaneSide, px: number) => Math.round(Math.min(PANES[side].max, Math.max(PANES[side].min, px)));

function load(): Record<PaneSide, number> {
  const widths = { left: PANES.left.def, right: PANES.right.def };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Record<PaneSide, unknown>>;
    for (const side of ['left', 'right'] as const) {
      const value = saved[side];
      if (typeof value === 'number' && Number.isFinite(value)) widths[side] = clamp(side, value);
    }
  } catch {
    /* storage unavailable or corrupt: the defaults apply */
  }
  return widths;
}

/**
 * Widths of the structure and properties panes, remembered per browser. While a splitter is dragged the width goes
 * straight into a CSS variable of the work area, so the panes do not re-render on every pointer move.
 */
export function usePaneWidths() {
  const workRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState(load);

  const drag = useCallback((side: PaneSide, px: number) => {
    workRef.current?.style.setProperty(PANES[side].css, `${clamp(side, px)}px`);
  }, []);
  const commit = useCallback((side: PaneSide, px: number) => {
    setWidths((current) => {
      const next = { ...current, [side]: clamp(side, px) };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable: the width only lasts for this visit */
      }
      return next;
    });
  }, []);

  return { workRef, sizes: widths, drag, commit };
}
