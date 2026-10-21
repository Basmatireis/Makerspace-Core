import { useState } from 'react';
import {
  Button,
  DataTable,
  InlineNotification,
  Link as CarbonLink,
  Pagination,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  Tag,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { StaffingStatus, SupervisorRowLaborordnungState } from '../../api/generated/models';
import { getSupervisorDashboard } from '../../api/generated/supervisors/supervisors';
import { BatchFilter, type FilterCategory, type FilterValues } from '../../app/BatchFilter';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';

const PAGE_SIZES = [10, 25, 50, 100];

type FilterOption<T extends string> = {
  value: T;
  label: string;
};

type ProfilePictureStatus = 'complete' | 'missing';

const PROFILE_PICTURE_STATUS_OPTIONS: Array<FilterOption<ProfilePictureStatus>> = [
  { value: 'complete', label: 'Complete' },
  { value: 'missing', label: 'Missing' },
];

const LAB_RULES_STATUS_OPTIONS: Array<FilterOption<SupervisorRowLaborordnungState>> = [
  { value: 'current', label: 'Current' },
  { value: 'outdated', label: 'Outdated' },
  { value: 'not_required', label: 'Not required' },
  { value: 'no_published_version', label: 'No published version' },
];

const STATUS_LABELS: Record<StaffingStatus, string> = {
  fulfilled: 'Minimum reached',
  missing: 'Below minimum',
  ready: 'Ready for supervisor',
};

function labRulesLabel(state: string): string {
  return state.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}

export function SupervisorStaffingPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterValues>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const canOpenPeople = hasPermission(currentUser, PermissionId.peoplereadall);
  const query = useQuery({
    queryKey: ['supervisor-dashboard'],
    queryFn: ({ signal }) => getSupervisorDashboard({ signal }),
  });

  if (query.isPending) return <FullPageLoading label="Loading supervisor staffing" />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title="Unable to load supervisor staffing"
        message="Check the connection and try again."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const dashboard = query.data;
  const headers = [
    { key: 'name', header: 'Member' },
    { key: 'photo', header: 'Profile picture' },
    { key: 'laborordnung', header: 'Lab Rules' },
    { key: 'openDays', header: 'Open days this semester' },
    { key: 'status', header: 'Status' },
  ];
  const minimum = dashboard.requirements.minOpenDaysPerSemester;
  const rows = dashboard.supervisors.map((supervisor) => ({
    id: supervisor.personId,
    name: supervisor.name,
    photo: supervisor.hasProfileImage ? 'Complete' : 'Missing',
    laborordnung: supervisor.laborordnungState,
    openDays: `${supervisor.staffed + supervisor.booked} of ${minimum}`,
    status: STATUS_LABELS[supervisor.status],
  }));
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const selectedProfilePictureStatuses = PROFILE_PICTURE_STATUS_OPTIONS.filter((option) =>
    filters.photo?.includes(option.value),
  );
  const selectedLabRulesStatuses = LAB_RULES_STATUS_OPTIONS.filter((option) =>
    filters.labRules?.includes(option.value),
  );
  const hasActiveFilters = selectedProfilePictureStatuses.length > 0 || selectedLabRulesStatuses.length > 0;
  const filterCategories: FilterCategory[] = [
    {
      key: 'photo',
      label: 'Profile picture',
      options: PROFILE_PICTURE_STATUS_OPTIONS.map((option) => ({ id: option.value, label: option.label })),
    },
    {
      key: 'labRules',
      label: 'Lab Rules',
      options: LAB_RULES_STATUS_OPTIONS.map((option) => ({ id: option.value, label: option.label })),
    },
  ];
  const filteredRows = rows.filter((row) => {
    if (normalizedSearch && !row.name.toLocaleLowerCase().includes(normalizedSearch)) {
      return false;
    }
    if (
      selectedProfilePictureStatuses.length > 0 &&
      !selectedProfilePictureStatuses.some((option) => option.label === row.photo)
    ) {
      return false;
    }
    if (
      selectedLabRulesStatuses.length > 0 &&
      !selectedLabRulesStatuses.some((option) => option.value === row.laborordnung)
    ) {
      return false;
    }
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleRows = filteredRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  return (
    <PageShell
      title="Supervisor staffing"
      breadcrumbs={[
        { label: 'Directory' },
        ...(canOpenPeople ? [{ label: 'People', to: '/people' }] : []),
        { label: 'Members' },
      ]}
      description="Profile-picture readiness, Lab Rules status, and open days this semester."
      width="wide"
      className="supervisor-staffing-page"
    >
      <section className="supervisor-staffing-main" aria-label="Members table">
        {dashboard.semester === null && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="No open-day period"
            subtitle="Members are shown without open-day counts."
          />
        )}

        <DataTable rows={visibleRows} headers={headers} isSortable>
          {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
            <TableContainer className="people-table-container supervisor-staffing-table">
              <TableToolbar aria-label="Members table toolbar">
                <TableToolbarContent>
                  <TableToolbarSearch
                    id="members-search"
                    labelText="Search members"
                    placeholder="Search members"
                    value={search}
                    onChange={(_event, value) => {
                      setSearch(value ?? '');
                      setPage(1);
                    }}
                    onClear={() => {
                      setSearch('');
                      setPage(1);
                    }}
                  />
                  <BatchFilter
                    id="members"
                    label="Members"
                    categories={filterCategories}
                    applied={filters}
                    onApply={(values) => {
                      setFilters(values);
                      setPage(1);
                    }}
                    onReset={() => {
                      setFilters({});
                      setPage(1);
                    }}
                  />
                  {canOpenPeople && (
                    <Button kind="tertiary" onClick={() => navigate('/people')}>
                      People
                    </Button>
                  )}
                </TableToolbarContent>
              </TableToolbar>
              <Table {...getTableProps()}>
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((header) => (
                      <TableHeader {...getHeaderProps({ header })} key={header.key}>
                        {header.header}
                      </TableHeader>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tableRows.map((row) => (
                    <TableRow {...getRowProps({ row })} key={row.id}>
                      {row.cells.map((cell) => (
                        <TableCell key={cell.id}>
                          {cell.info.header === 'name' && canOpenPeople ? (
                            <CarbonLink
                              href={`/people/${row.id}`}
                              onClick={(event) => {
                                event.preventDefault();
                                navigate(`/people/${row.id}`);
                              }}
                            >
                              {String(cell.value)}
                            </CarbonLink>
                          ) : cell.info.header === 'photo' ? (
                            <Tag type={cell.value === 'Complete' ? 'green' : 'red'}>{String(cell.value)}</Tag>
                          ) : cell.info.header === 'laborordnung' ? (
                            <Tag type={cell.value === 'current' || cell.value === 'not_required' ? 'green' : 'red'}>
                              {labRulesLabel(String(cell.value))}
                            </Tag>
                          ) : (
                            String(cell.value)
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {filteredRows.length === 0 && (
                <div className="empty-state">
                  <h2>{search || hasActiveFilters ? 'No members found' : 'No designated supervisors'}</h2>
                  <p>
                    {search || hasActiveFilters
                      ? 'Try different search terms or filters.'
                      : 'Assign a role configured as a supervisor role to include someone here.'}
                  </p>
                </div>
              )}
              <Pagination
                page={currentPage}
                pageSize={pageSize}
                totalItems={filteredRows.length}
                pageSizes={PAGE_SIZES}
                onChange={({ page: nextPage, pageSize: nextPageSize }) => {
                  setPage(nextPage);
                  setPageSize(nextPageSize);
                }}
              />
            </TableContainer>
          )}
        </DataTable>
      </section>
    </PageShell>
  );
}
