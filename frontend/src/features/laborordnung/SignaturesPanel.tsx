import { Link as CarbonLink } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { LaborordnungSignature, LaborordnungVersion } from '../../api/generated/models';
import {
  ListLaborordnungSignaturesDirection,
  ListLaborordnungSignaturesSort,
  type ListLaborordnungSignaturesParams,
} from '../../api/generated/models';
import { formatDate, formatDateTime } from '../../app/dateTime';
import { DirectoryTable, useServerTableState, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { SettingsSection } from '../settings/SettingsPageLayout';
import { signaturesQuery } from './queries';

const sortKeys = Object.values(ListLaborordnungSignaturesSort) as string[];

const columns: Column<LaborordnungSignature>[] = [
  {
    key: 'person',
    header: 'Person',
    render: (signature) => (
      <CarbonLink as={Link} to={`/users/${signature.personId}`}>
        {signature.personName}
      </CarbonLink>
    ),
  },
  { key: 'version', header: 'Revision', render: (signature) => signature.humanRevision },
  {
    key: 'signedDate',
    header: 'Signed',
    narrow: true,
    firstDirection: 'DESC',
    render: (signature) => (signature.signedDate ? formatDate(signature.signedDate) : '—'),
  },
  {
    key: 'reference',
    header: 'Document reference',
    narrow: true,
    render: (signature) => signature.physicalDocumentReference ?? '—',
  },
  { key: 'confirmedBy', header: 'Confirmed by', narrow: true, render: (signature) => signature.confirmedByName ?? '—' },
  {
    key: 'confirmedAt',
    header: 'Confirmed at',
    narrow: true,
    firstDirection: 'DESC',
    render: (signature) => formatDateTime(signature.confirmedAt),
  },
];

/** Confirmed physical signatures of the Lab Rules, searchable and paged by the server. Needs `laborordnung.requests.read`. */
export function SignaturesPanel({ versions }: { versions: LaborordnungVersion[] }) {
  const table = useServerTableState('sig-', { key: 'confirmedAt', direction: 'DESC' });
  const requestedVersion = table.url.get('version');
  const params: ListLaborordnungSignaturesParams = {
    search: table.search || undefined,
    versionId: versions.some((version) => version.id === requestedVersion) ? requestedVersion : undefined,
    sort: (sortKeys.includes(table.sort.key) ? table.sort.key : 'confirmedAt') as ListLaborordnungSignaturesSort,
    direction:
      table.sort.direction === 'ASC'
        ? ListLaborordnungSignaturesDirection.asc
        : ListLaborordnungSignaturesDirection.desc,
    page: table.page,
    pageSize: table.pageSize,
  };
  const query = useQuery({ ...signaturesQuery(params), placeholderData: keepPreviousData });

  return (
    <SettingsSection
      title="Signatures"
      description="Every signed Lab Rules document a supervisor has confirmed, with the reference to find it in the physical archive."
    >
      <QueryBoundary query={query} errorMessage="Signatures could not be loaded.">
        {(page) => (
          <DirectoryTable
            mode="server"
            id="signatures"
            urlPrefix="sig-"
            label="Signatures"
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
            ]}
            empty={{
              title: 'No signatures yet',
              description: 'Signatures appear here once a supervisor confirms a signed document.',
            }}
          />
        )}
      </QueryBoundary>
    </SettingsSection>
  );
}
