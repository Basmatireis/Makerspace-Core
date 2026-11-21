import { Fragment, type ReactNode } from 'react';
import { IconButton } from '@carbon/react';
import { Close } from '@carbon/icons-react';

/**
 * The head of a working-group detail panel as in the prototype: a small label ("Project · 3D printing"), the title,
 * a meta line with dot separators and the tags; menus and the close button sit at the end.
 */
export function PanelHead({
  label,
  title,
  meta,
  tags,
  actions,
  onClose,
}: {
  label: string;
  title: string;
  meta: ReactNode[];
  tags?: ReactNode;
  actions?: ReactNode;
  onClose?: () => void;
}) {
  const parts = meta.filter((part) => part !== null && part !== undefined && part !== false && part !== '');
  return (
    <header className="wg-ph">
      <div className="wg-ph__lines">
        <p className="wg-ph__label">{label}</p>
        <h2 className="wg-ph__title">{title}</h2>
        {parts.length > 0 && (
          <p className="wg-ph__meta">
            {parts.map((part, index) => (
              <Fragment key={index}>
                {index > 0 && (
                  <span className="wg-ph__dot" aria-hidden="true">
                    ·
                  </span>
                )}
                <span>{part}</span>
              </Fragment>
            ))}
          </p>
        )}
        {tags && <div className="wg-ph__tags">{tags}</div>}
      </div>
      {(actions || onClose) && (
        <div className="wg-ph__actions">
          {actions}
          {onClose && (
            <IconButton kind="ghost" size="md" label="Close" align="left" onClick={onClose}>
              <Close />
            </IconButton>
          )}
        </div>
      )}
    </header>
  );
}

/** "Purchases 2": a panel sub-section title with the count at the end. */
export function PanelSection({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="wg-psec" aria-label={title}>
      <h3 className="wg-psec__title">
        {title}
        {count !== undefined && <span>{count}</span>}
      </h3>
      {children}
    </section>
  );
}
