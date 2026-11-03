/* eslint-disable react-refresh/only-export-components -- the layout and its breakpoint hook belong together */
import { useSyncExternalStore, type ReactNode } from 'react';
import './blocks.scss';

// Carbon's lg breakpoint (1056 px): from here on the detail panel sits next to the list.
const PANEL_QUERY = '(min-width: 66rem)';

function subscribe(listener: () => void) {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const media = window.matchMedia(PANEL_QUERY);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

const panelFits = () => typeof window.matchMedia === 'function' && window.matchMedia(PANEL_QUERY).matches;

/**
 * Whether the viewport is wide enough (≥ 1056 px) for `ListWithPanel` to show its panel. Pages use it to decide what
 * a row click does: select the row for the panel, or navigate to the row's detail page.
 */
export function useListPanelLayout(): boolean {
  return useSyncExternalStore(subscribe, panelFits);
}

export interface ListWithPanelProps {
  /** The list column: usually the toolbar and data table. */
  children: ReactNode;
  /** The panel content, typically a `DetailPanel` for the selected row or an empty state. Rendered only when it fits. */
  panel: ReactNode;
  /** Accessible name of the panel region, e.g. "Spool details". */
  panelLabel: string;
  className?: string;
}

/**
 * The list-and-panel split of the Workshop and Sales lists (`.split` / `.split--always`): the list grows, the panel
 * has a fixed width of 25 rem, is at least as tall as the list, and its content sticks below the shell header and
 * scrolls on its own. Below 1056 px the list takes the full width and the panel is not rendered at all.
 */
export function ListWithPanel({ children, panel, panelLabel, className }: ListWithPanelProps) {
  const panelVisible = useListPanelLayout();
  const classes = ['list-panel', panelVisible && 'list-panel--split', className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <div className="list-panel__list">{children}</div>
      {panelVisible && (
        <aside className="list-panel__panel" aria-label={panelLabel}>
          <div className="list-panel__sticky">{panel}</div>
        </aside>
      )}
    </div>
  );
}
