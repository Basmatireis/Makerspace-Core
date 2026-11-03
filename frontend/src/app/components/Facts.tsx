import type { CSSProperties, ReactNode } from 'react';
import { Tile } from '@carbon/react';
import './blocks.scss';

/**
 * A grid of label/value facts (`.facts` / `.fact`) as a description list: at most `columns` columns (2–4), fewer when
 * the container is narrow.
 */
export function FactsGrid({ columns = 2, children }: { columns?: 2 | 3 | 4; children: ReactNode }) {
  return (
    <dl className="facts-grid" style={{ '--facts-columns': columns } as CSSProperties}>
      {children}
    </dl>
  );
}

/** One fact of a `FactsGrid`: a label-01 label above a body-compact value, with an optional helper line. */
export function Fact({ label, children, helper }: { label: string; children: ReactNode; helper?: ReactNode }) {
  return (
    <div className="facts-grid__fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
      {helper && <dd className="facts-grid__helper">{helper}</dd>}
    </div>
  );
}

export interface FactTile {
  /** Stable key; defaults to the label. */
  id?: string;
  label: string;
  value: ReactNode;
  helper?: ReactNode;
}

/**
 * The strip of equal fact tiles under a page head (`.tiles--facts`): Carbon tiles with a label, a large value and an
 * optional helper line, wrapping to fewer columns at narrow width.
 */
export function FactTiles({ items, label }: { items: FactTile[]; label?: string }) {
  return (
    <dl className="fact-tiles" aria-label={label}>
      {items.map((item) => (
        <Tile key={item.id ?? item.label} className="fact-tiles__tile">
          <dt>{item.label}</dt>
          <dd className="fact-tiles__value">{item.value}</dd>
          {item.helper && <dd className="fact-tiles__helper">{item.helper}</dd>}
        </Tile>
      ))}
    </dl>
  );
}
