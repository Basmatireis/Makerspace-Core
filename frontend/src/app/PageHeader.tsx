import { useId, type ReactNode } from 'react';
import { Breadcrumb, BreadcrumbItem, Heading, Stack } from '@carbon/react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../features/branding/branding';

export type PageCrumb = {
  label: string;
  to?: string;
};

export type PageHeaderProps = {
  title: string;
  titleAdornment?: ReactNode;
  description?: string;
  breadcrumbs?: PageCrumb[];
  actions?: ReactNode;
  tabs?: ReactNode;
};

export function PageHeader({
  title,
  titleAdornment,
  description,
  breadcrumbs = [],
  actions,
  tabs,
}: PageHeaderProps) {
  usePageTitle(title);
  const titleId = useId();

  return (
    <header className={`page-header${tabs ? ' page-header--with-tabs' : ''}`} aria-labelledby={titleId}>
      <Stack gap={5} className="page-header__body">
        {breadcrumbs.length > 0 && (
          <Breadcrumb noTrailingSlash>
            {breadcrumbs.map((crumb) => (
              <BreadcrumbItem
                key={`${crumb.label}-${crumb.to ?? 'current'}`}
                isCurrentPage={!crumb.to}
              >
                {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : crumb.label}
              </BreadcrumbItem>
            ))}
          </Breadcrumb>
        )}
        <div className="page-header__row">
          <div className="page-header__title">
            <div className="page-header__heading">
              <Heading id={titleId}>{title}</Heading>
              {titleAdornment}
            </div>
            {description && <p className="page-header__description">{description}</p>}
          </div>
          {actions && <div className="page-header__actions">{actions}</div>}
        </div>
      </Stack>
      {tabs && <div className="page-header__tabs">{tabs}</div>}
    </header>
  );
}
