import type { ReactNode } from 'react';
import {
  Stack,
  StructuredListCell,
  StructuredListRow,
  Tag,
  Tile,
} from '@carbon/react';

export function DetailSection({
  title,
  description,
  headingContent,
  meta,
  action,
  className,
  children,
}: {
  title: string;
  description?: string;
  headingContent?: ReactNode;
  meta?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tile className={`person-detail-card${className ? ` ${className}` : ''}`}>
      <Stack gap={6} className="person-detail-card__content">
        <div className="person-detail-card__heading">
          <div>
            <h2>{title}</h2>
            {description && <p className="section-description">{description}</p>}
          </div>
          {headingContent && <div className="person-detail-card__heading-content">{headingContent}</div>}
          {(meta || action) && <div className="person-detail-card__actions">{meta}{action}</div>}
        </div>
        {children}
      </Stack>
    </Tile>
  );
}

export function DetailRow({
  label,
  value,
  monospace = false,
  action,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  action?: ReactNode;
}) {
  return (
    <StructuredListRow>
      <StructuredListCell>{label}</StructuredListCell>
      <StructuredListCell>
        <span className="person-detail-row__value">{monospace ? <code>{value}</code> : value}{action}</span>
      </StructuredListCell>
    </StructuredListRow>
  );
}

export function AuthenticationMethod({
  label,
  status,
  detail,
  active,
  warning = false,
  action,
  children,
}: {
  label: string;
  status: string;
  detail?: string;
  active: boolean;
  warning?: boolean;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="authentication-method">
      <div className="authentication-method__header">
        <div className="authentication-method__summary"><strong>{label}</strong>{detail && <span>{detail}</span>}</div>
        <div className="authentication-method__actions">
          <Tag type={warning ? 'warm-gray' : active ? 'green' : 'gray'}>{status}</Tag>
          {action}
        </div>
      </div>
      {children}
    </div>
  );
}
