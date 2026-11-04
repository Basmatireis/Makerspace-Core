import { Link as CarbonLink } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { LaborordnungConfirmation, LaborordnungVersion } from '../../api/generated/models';
import {
  LaborordnungConfirmationMethod,
  ListLaborordnungConfirmationsDirection,
  ListLaborordnungConfirmationsSort,
  type ListLaborordnungConfirmationsParams,
} from '../../api/generated/models';
import { formatDateTime } from '../../app/dateTime';
import { DirectoryTable, useServerTableState, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { SettingsSection } from '../settings/SettingsPageLayout';
import { confirmationMethodLabels, confirmationsQuery } from './queries';

const sortKeys = Object.values(ListLaborordnungConfirmationsSort) as string[];
const methods = Object.values(LaborordnungConfirmationMethod) as string[];

const columns: Column<LaborordnungConfirmation>[] = [
  {
    key: 'person',
    header: 'Person',
    sortValue: (confirmation) => confirmation.personName,
    render: (confirmation) => (
      <CarbonLink as={Link} to={`/users/${confirmation.personId}`}>
        {confirmation.personName}
      </CarbonLink>
    ),
  },
  {
    key: 'version',
    header: 'Revision',
    sortValue: (confirmation) => confirmation.humanRevision,
    render: (confirmation) => confirmation.humanRevision,
  },
  {
    key: 'method',
    header: 'Method',
    narrow: true,
    sortValue: (confirmation) => confirmation.method,
    render: (confirmation) => confirmationMethodLabels[confirmation.method],
  },
  {
    key: 'confirmedAt',
    header: 'Confirmed at',
    sortValue: (confirmation) => confirmation.confirmedAt,
    narrow: true,
    firstDirection: 'DESC',
    render: (confirmation) => formatDateTime(confirmation.confirmedAt),
  },
  {
    key: 'reference',
    header: 'Document reference',
    narrow: true,
    render: (confirmation) => confirmation.physicalDocumentReference ?? '—',
  },
];

/** Who confirmed which Lab Rules version and how, searchable and paged by the server. Needs `laborordnung.confirmations.read`. */
export function ConfirmationsPanel({ versions }: { versions: LaborordnungVersion[] }) {
  const table = useServerTableState('conf-', { key: 'confirmedAt', direction: 'DESC' });
  const requestedVersion = table.url.get('version');
  const requestedMethod = table.url.get('method');
  const params: ListLaborordnungConfirmationsParams = {
    search: table.search || undefined,
    versionId: versions.some((version) => version.id === requestedVersion) ? requestedVersion : undefined,
    method:
      requestedMethod && methods.includes(requestedMethod)
        ? (requestedMethod as LaborordnungConfirmationMethod)
        : undefined,
    sort: (sortKeys.includes(table.sort.key) ? table.sort.key : 'confirmedAt') as ListLaborordnungConfirmationsSort,
    direction:
      table.sort.direction === 'ASC'
        ? ListLaborordnungConfirmationsDirection.asc
        : ListLaborordnungConfirmationsDirection.desc,
    page: table.page,
    pageSize: table.pageSize,
  };
  const query = useQuery({ ...confirmationsQuery(params), placeholderData: keepPreviousData });

  return (
    <SettingsSection
      title="Confirmations"
      description="Who confirmed which Lab Rules revision, and how. Paper confirmations from before people confirmed themselves keep the reference to their document."
    >
      <QueryBoundary query={query} errorMessage="Confirmations could not be loaded.">
        {(page) => (
          <DirectoryTable
            mode="server"
            id="confirmations"
            urlPrefix="conf-"
            label="Confirmations"
            columns={columns}
            rows={page.items}
            total={page.total}
            sort={table.sort}
            onSortChange={table.setSort}
            filterCategories={[
              {
                key: 'version',
                label: 'Revision',
                single: true,
                options: versions.map((version) => ({ id: version.id, label: version.humanRevision })),
              },
              {
                key: 'method',
                label: 'Method',
                single: true,
                options: Object.entries(confirmationMethodLabels).map(([id, label]) => ({ id, label })),
              },
            ]}
            empty={{
              title: 'No confirmations yet',
              description: 'Confirmations appear here once people confirm a Lab Rules revision.',
            }}
          />
        )}
      </QueryBoundary>
    </SettingsSection>
  );
}
