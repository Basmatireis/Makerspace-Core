import type { ReactNode } from 'react';

export type SummaryItem = { label: string; value: ReactNode; mono?: boolean };

/** A label/value list with labels on the start side (`.summary`), for cards and panels of the Machines pages. */
export function SummaryList({ items, label }: { items: (SummaryItem | null | false)[]; label?: string }) {
  return (
    <dl className="mj-summary" aria-label={label}>
      {items
        .filter((item): item is SummaryItem => Boolean(item))
        .map((item) => (
          <div key={item.label} className="mj-summary__row">
            <dt>{item.label}</dt>
            <dd className={item.mono ? 'mj-summary__mono' : undefined}>{item.value}</dd>
          </div>
        ))}
    </dl>
  );
}
