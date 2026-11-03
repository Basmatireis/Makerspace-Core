import type { ReactNode } from 'react';
import './blocks.scss';

/**
 * The detail panel next to a list (`.panel`): a layer with an accent on the start edge, holding a `DetailPanelHead`
 * and `DetailPanelSection`s.
 */
export function DetailPanel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `detail-panel ${className}` : 'detail-panel'}>{children}</div>;
}

export interface DetailPanelHeadProps {
  /** Line 1, heading-03; truncated with an ellipsis (a string title is repeated as the tooltip). */
  title: ReactNode;
  /** Id of the heading, e.g. for `aria-labelledby` of a surrounding region. */
  titleId?: string;
  /** Line 2, the primary meta in body-compact-01 (colour, manufacturer, customer…). */
  meta?: ReactNode;
  /** Line 3, secondary meta in label-01 (identifiers, location). */
  secondary?: ReactNode;
  /** Line 4, helper text or tags. */
  helper?: ReactNode;
  /** Buttons at the end of the head, e.g. a close icon button. */
  actions?: ReactNode;
}

/**
 * The fixed four-line head of a detail panel (`.panel__head--fixed`). Every line keeps its height when empty, so the
 * heads of different panels line up and the body does not jump while the selection changes.
 */
export function DetailPanelHead({ title, titleId, meta, secondary, helper, actions }: DetailPanelHeadProps) {
  return (
    <header className="detail-panel__head">
      <div className="detail-panel__lines">
        <h2 id={titleId} className="detail-panel__title" title={typeof title === 'string' ? title : undefined}>
          {title}
        </h2>
        <p className="detail-panel__meta">{meta}</p>
        <p className="detail-panel__secondary">{secondary}</p>
        <div className="detail-panel__helper">{helper}</div>
      </div>
      {actions && <div className="detail-panel__actions">{actions}</div>}
    </header>
  );
}

/** A titled block of the panel body (`.pb`), with an optional action at the end of the title row. */
export function DetailPanelSection({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="detail-panel__section">
      {(title || action) && (
        <div className="detail-panel__section-head">
          {title && <h3 className="detail-panel__section-title">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * Lets a Carbon `DataTable` run edge to edge inside a `DetailPanel` (`.panel__bleed` / `.dt--panel`): no outer
 * padding, outer cells aligned with the panel text. Use the table's `size="sm"` for compact rows.
 */
export function PanelBleed({ children }: { children: ReactNode }) {
  return <div className="detail-panel__bleed">{children}</div>;
}
