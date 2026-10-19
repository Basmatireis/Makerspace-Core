import { useState } from 'react';
import { Button, Link as CarbonLink, Tag } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { ListOrganizationsParams, Organization, OrganizationKind } from '../../api/generated/models';
import type { FilterCategory } from '../../app/BatchFilter';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { pricingQuery } from '../machinelogbook/queries';
import { DirectoryTable, useServerTableState, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { OrganizationFormModal } from './OrganizationFormModal';
import { organizationKindLabels, organizationKinds, organizationPaths } from './presentation';
import { organizationsQuery } from './queries';

const columns: Column<Organization>[] = [
  {
    key: 'name', header: 'Organization',
    render: (organization) => (
      <div className="mj-cell-stack">
        <CarbonLink as={Link} to={organizationPaths.detail(organization.id)}>{organization.name}</CarbonLink>
        <span className="mj-secondary mj-show-narrow">{organizationKindLabels[organization.kind]}</span>
      </div>
    ),
  },
  { key: 'kind', header: 'Kind', narrow: true, render: (organization) => organizationKindLabels[organization.kind] },
  {
    key: 'active', header: 'Status',
    render: (organization) => <Tag size="sm" type={organization.active ? 'green' : 'gray'}>{organization.active ? 'Active' : 'Inactive'}</Tag>,
  },
  { key: 'pricingGroup', header: 'Pricing group', narrow: true, render: (organization) => organization.pricingGroup?.name ?? <span className="mj-secondary">Default</span> },
  { key: 'members', header: 'People', narrow: true, render: (organization) => organization.memberCount },
];

export function OrganizationsPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const canManage = hasPermission(currentUser, PermissionId.organizationsmanage);
  const canReadPricing = hasPermission(currentUser, PermissionId.pricingread);
  const table = useServerTableState('', { key: 'name', direction: 'ASC' });
  const { url } = table;
  const [createOpen, setCreateOpen] = useState(false);
  const pricing = useQuery({ ...pricingQuery(), enabled: canReadPricing });

  const kind = url.get('kind');
  const active = url.get('active');
  const pricingGroupId = url.get('pricingGroup');
  const params: ListOrganizationsParams = {
    search: table.search || undefined,
    kind: organizationKinds.includes(kind as OrganizationKind) ? kind as OrganizationKind : undefined,
    active: active === 'true' ? true : active === 'false' ? false : undefined,
    pricingGroupId: pricingGroupId || undefined,
    page: table.page,
    pageSize: table.pageSize,
  };
  const query = useQuery({ ...organizationsQuery(params), placeholderData: keepPreviousData });
  const groups = pricing.data?.items ?? [];

  const filterCategories: FilterCategory[] = [
    { key: 'kind', label: 'Kind', single: true, options: organizationKinds.map((item) => ({ id: item, label: organizationKindLabels[item] })) },
    { key: 'active', label: 'Status', single: true, options: [{ id: 'true', label: 'Active' }, { id: 'false', label: 'Inactive' }] },
    ...(canReadPricing ? [{ key: 'pricingGroup', label: 'Pricing group', single: true, options: groups.map((group) => ({ id: group.id, label: group.name })) }] : []),
  ];

  return (
    <PageShell
      title="Organizations" description="Companies, institutes and associations that can be billed, with their invoice data and people." width="wide"
      breadcrumbs={[{ label: 'Directory' }, { label: 'Organizations' }]}
    >
      <QueryBoundary query={query} errorMessage="Organizations could not be loaded.">
        {(page) => (
          <DirectoryTable
            mode="server" id="organizations" urlPrefix="" label="Organizations" columns={columns} rows={page.items} total={page.total}
            sort={table.sort} onSortChange={table.setSort}
            filterCategories={filterCategories}
            toolbarAction={canManage ? <Button kind="primary" size="lg" onClick={() => setCreateOpen(true)}>New organization</Button> : undefined}
            empty={{
              title: 'No organizations yet', description: 'Organizations can be billed for jobs and orders once they are added.',
              action: canManage ? <Button kind="tertiary" onClick={() => setCreateOpen(true)}>New organization</Button> : undefined,
            }}
          />
        )}
      </QueryBoundary>
      {canManage && (
        <OrganizationFormModal
          open={createOpen} onClose={() => setCreateOpen(false)}
          onCreated={(organization) => { setCreateOpen(false); navigate(organizationPaths.detail(organization.id)); }}
        />
      )}
    </PageShell>
  );
}
