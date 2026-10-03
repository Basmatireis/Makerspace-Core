import type { ReactNode } from 'react';
import { PageHeader, type PageHeaderProps } from './PageHeader';

export type PageShellWidth = 'standard' | 'wide' | 'fluid';

export type PageShellProps = PageHeaderProps & {
  children: ReactNode;
  className?: string;
  width?: PageShellWidth;
};

export function PageShell({
  title,
  titleAdornment,
  description,
  breadcrumbs,
  actions,
  tabs,
  children,
  className,
  width = 'standard',
}: PageShellProps) {
  const classes = ['page-shell', `page-shell--${width}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} data-page-shell data-page-width={width}>
      <PageHeader
        title={title}
        titleAdornment={titleAdornment}
        description={description}
        breadcrumbs={breadcrumbs}
        actions={actions}
        tabs={tabs}
      />
      <div className="page-shell__content">{children}</div>
    </div>
  );
}
