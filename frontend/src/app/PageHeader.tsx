import type { ReactNode } from 'react';
import { Breadcrumb, BreadcrumbItem, Heading, Stack } from '@carbon/react';
import { Link } from 'react-router-dom';

export type PageCrumb = {
  label: string;
  to?: string;
};

type PageHeaderProps = {
  title: string;
  description?: string;
  breadcrumbs?: PageCrumb[];
  actions?: ReactNode;
};

export function PageHeader({
  title,
  description,
  breadcrumbs = [],
  actions,
}: PageHeaderProps) {
  return (
    <Stack gap={5} className="page-header">
      {breadcrumbs.length > 0 && (
        <Breadcrumb noTrailingSlash>
          {breadcrumbs.map((crumb) => (
            <BreadcrumbItem key={`${crumb.label}-${crumb.to ?? 'current'}`}>
              {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : crumb.label}
            </BreadcrumbItem>
          ))}
        </Breadcrumb>
      )}
      <div className="page-header__row">
        <div>
          <Heading>{title}</Heading>
          {description && <p className="page-header__description">{description}</p>}
        </div>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
    </Stack>
  );
}
