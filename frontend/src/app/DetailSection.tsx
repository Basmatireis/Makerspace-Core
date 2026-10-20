import type { ReactNode } from 'react';
import { Stack, StructuredListCell, StructuredListRow, Tile } from '@carbon/react';

export type DetailSectionProps = {
  title: string;
  description?: string;
  headingContent?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function DetailSection({
  title,
  description,
  headingContent,
  meta,
  action,
  className,
  children,
}: DetailSectionProps) {
  const classes = ['detail-section', 'person-detail-card', className].filter(Boolean).join(' ');

  return (
    <Tile className={classes}>
      <Stack gap={6} className="detail-section__content person-detail-card__content">
        <div className="detail-section__heading person-detail-card__heading">
          <div>
            <h2>{title}</h2>
            {description && <p className="section-description">{description}</p>}
          </div>
          {headingContent && (
            <div className="detail-section__heading-content person-detail-card__heading-content">{headingContent}</div>
          )}
          {(meta || action) && (
            <div className="detail-section__actions person-detail-card__actions">
              {meta}
              {action}
            </div>
          )}
        </div>
        {children}
      </Stack>
    </Tile>
  );
}

export type DetailRowProps = {
  label: string;
  value: ReactNode;
  monospace?: boolean;
  action?: ReactNode;
};

export function DetailRow({ label, value, monospace = false, action }: DetailRowProps) {
  return (
    <StructuredListRow>
      <StructuredListCell>{label}</StructuredListCell>
      <StructuredListCell>
        <span className="detail-row__value person-detail-row__value">
          {monospace ? <code>{value}</code> : value}
          {action}
        </span>
      </StructuredListCell>
    </StructuredListRow>
  );
}
