import { SkeletonText } from '@carbon/react';
import type { ReactNode } from 'react';
import { PageShell, type PageShellWidth } from '../../app/PageShell';
import { settingsGroup, settingsItem, type SettingsPageId } from './settingsCatalog';

type SettingsPageLayoutProps = {
  page: SettingsPageId;
  /** Overrides the catalog description. */
  description?: string;
  actions?: ReactNode;
  tabs?: ReactNode;
  width?: PageShellWidth;
  className?: string;
  children: ReactNode;
};

/** One frame for every settings screen: "Settings / Group / Page" breadcrumb, title, description, content. */
export function SettingsPageLayout({ page, description, children, ...shell }: SettingsPageLayoutProps) {
  const item = settingsItem(page);
  const group = settingsGroup(item.group);
  return (
    <PageShell
      title={item.title}
      description={description ?? item.description}
      breadcrumbs={[
        { label: 'Settings', to: '/settings' },
        { label: group.title, to: `/settings#${group.id}` },
      ]}
      {...shell}
    >
      {children}
    </PageShell>
  );
}

type SettingsSectionProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  children?: ReactNode;
};

/** A titled block inside a settings screen or tab; actions sit at the end of the heading row. */
export function SettingsSection({ title, description, actions, children }: SettingsSectionProps) {
  return (
    <section className="settings-section">
      <div className="section-heading">
        <div>
          <h2>{title}</h2>
          {description && <p className="settings-section__description">{description}</p>}
        </div>
        {actions && <div className="settings-section__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Skeleton placeholder with an accessible, visually hidden label. */
export function SettingsLoading({ label }: { label: string }) {
  return (
    <div role="status" className="settings-loading">
      <span className="cds--visually-hidden">{label}</span>
      <SkeletonText paragraph lineCount={3} aria-hidden="true" />
    </div>
  );
}
