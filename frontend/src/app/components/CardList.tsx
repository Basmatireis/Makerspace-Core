import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import './blocks.scss';

export interface StackCardProps {
  title: string;
  /** Shown after the title in secondary text, e.g. how many items need attention. */
  count?: number;
  /** One action at the end of the title row, typically a ghost `Button` such as "All orders". */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A titled card on a layer (`.card` with `.card__title--row`): title row with an optional count and action. */
export function StackCard({ title, count, action, children, className }: StackCardProps) {
  const titleId = useId();
  return (
    <section className={className ? `stack-card ${className}` : 'stack-card'} aria-labelledby={titleId}>
      <div className="stack-card__head">
        <h2 id={titleId} className="stack-card__title">
          {title}
          {count !== undefined && <span className="stack-card__count">{count}</span>}
        </h2>
        {action && <div className="stack-card__action">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export interface CardListItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** Tags or an action button at the end of the row. */
  aside?: ReactNode;
  /** Makes the whole row a link. Do not combine with interactive content in `aside`. */
  to?: string;
}

export interface CardListProps extends Omit<StackCardProps, 'children'> {
  items: CardListItem[];
  /** Shown instead of the rows when there are none. */
  emptyText: string;
}

/**
 * The list cards of the sales overview (`.card--list`): a `StackCard` with compact two-line rows separated by
 * hairlines; a row with `to` is a link.
 */
export function CardList({ items, emptyText, ...card }: CardListProps) {
  return (
    <StackCard {...card}>
      {items.length === 0 ? (
        <p className="card-list__empty">{emptyText}</p>
      ) : (
        <ul className="card-list__rows">
          {items.map((item) => {
            const content = (
              <>
                <span className="card-list__main">
                  <span className="card-list__row-title">{item.title}</span>
                  {item.description && <span className="card-list__row-description">{item.description}</span>}
                </span>
                {item.aside && <span className="card-list__aside">{item.aside}</span>}
              </>
            );
            return (
              <li key={item.id}>
                {item.to ? (
                  <Link className="card-list__row" to={item.to}>
                    {content}
                  </Link>
                ) : (
                  <div className="card-list__row">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </StackCard>
  );
}
