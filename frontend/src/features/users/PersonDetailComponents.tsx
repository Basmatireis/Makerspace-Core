import type { ReactNode } from 'react';
import { Tag } from '@carbon/react';

export {
  DetailRow,
  DetailSection,
  type DetailRowProps,
  type DetailSectionProps,
} from '../../app/DetailSection';

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
