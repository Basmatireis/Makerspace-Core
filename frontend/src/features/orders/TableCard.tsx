import { useId, type ReactNode } from 'react';

/**
 * A table on the order page: a title row with a count and one action, the Carbon table directly below it. The table
 * keeps its own accessible name; the section is labelled by the title.
 */
export function TableCard({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="sales-table-card" aria-labelledby={titleId}>
      <div className="sales-table-card__head">
        <h2 id={titleId} className="sales-table-card__title">
          {title}
          {count !== undefined && <span className="sales-count">{count}</span>}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
