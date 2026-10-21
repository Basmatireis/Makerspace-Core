import type { ReactNode } from 'react';
import { Tile } from '@carbon/react';

/** Key-value strip under a page title: fixed labels, values (text or tags) in the same place on every event. */
export function SummaryStrip({ label, items }: { label: string; items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="ev-strip" aria-label={label}>
      {items.map((item) => (
        <div key={item.label}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Row of small tiles: label on top, big number below. */
export function SummaryTiles({ items }: { items: { label: string; value: ReactNode; detail?: ReactNode }[] }) {
  return (
    <div className="ev-summary">
      {items.map((item) => (
        <Tile key={item.label}>
          <span className="ev-secondary">{item.label}</span>
          <strong className="ev-summary__value">{item.value}</strong>
          {item.detail}
        </Tile>
      ))}
    </div>
  );
}

/** One toolbar per section: filters and switchers left, add actions right. */
export function TabToolbar({ left, right }: { left?: ReactNode; right?: ReactNode }) {
  if (!left && !right) return null;
  return (
    <div className="ev-toolbar">
      <div className="ev-toolbar__left">{left}</div>
      {right && <div className="ev-toolbar__right">{right}</div>}
    </div>
  );
}

/** Section heading with a short summary on the same line and optional actions on the right. */
export function SectionHeading({
  title,
  summary,
  actions,
  level = 2,
}: {
  title: ReactNode;
  summary?: ReactNode;
  actions?: ReactNode;
  level?: 2 | 3;
}) {
  const Heading = `h${level}` as 'h2' | 'h3';
  return (
    <div className="ev-heading">
      <Heading className="ev-heading__title">
        {title}
        {summary && <span className="ev-heading__summary">{summary}</span>}
      </Heading>
      {actions}
    </div>
  );
}
