import type { ReactNode } from 'react';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { rolePresets, useStore, type Permission } from '../../store';

/** Frontend authorization is UX only: the backend enforces the same permissions. */
export function RequirePermission({ permission, title, crumbs, children }: { permission: Permission | Permission[]; title: string; crumbs?: { label: string; to?: string }[]; children: ReactNode }) {
  const store = useStore();
  const needed = Array.isArray(permission) ? permission : [permission];
  if (needed.every((item) => store.can(item))) return <>{children}</>;
  return (
    <PageShell title={title} breadcrumbs={crumbs ?? [{ label: 'Sales & payments' }]} width="wide">
      <EmptyState title="You do not have access to this page" description={`The role “${rolePresets[store.role].label}” lacks the permission it needs. Switch the role in the prototype controls to see it.`} />
    </PageShell>
  );
}
