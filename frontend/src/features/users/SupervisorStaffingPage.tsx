import { useState } from 'react';
import {
  Button,
  DataTable,
  Dropdown,
  InlineNotification,
  Link as CarbonLink,
  MultiSelect,
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
import { Filter } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { SupervisorRowLaborordnungState } from '../../api/generated/models';
import { getSupervisorDashboard } from '../../api/generated/supervisors/supervisors';
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

function labRulesLabel(state: string): string {
  return state.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}

export function SupervisorStaffingPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedProfilePictureStatuses, setSelectedProfilePictureStatuses] = useState<
    Array<FilterOption<ProfilePictureStatus>>
  >([]);
  const [selectedLabRulesStatuses, setSelectedLabRulesStatuses] = useState<
    Array<FilterOption<SupervisorRowLaborordnungState>>
  >([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
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
  const selectedPeriod = dashboard.periods.find((period) => period.id === selectedPeriodId)
    ?? dashboard.periods[0]
    ?? null;
  const headers = [
    { key: 'name', header: 'Member' },
    { key: 'photo', header: 'Profile picture' },
    { key: 'laborordnung', header: 'Lab Rules' },
    { key: 'supervisorAssignments', header: 'Supervisor' },
    { key: 'traineeAssignments', header: 'Trainee' },
  ];
  const rows = dashboard.supervisors.map((supervisor) => {
    const assignmentCount = selectedPeriod
      ? supervisor.assignmentCounts.find((count) => count.periodId === selectedPeriod.id)
      : undefined;
    return {
      id: supervisor.personId,
      name: supervisor.name,
      photo: supervisor.hasProfileImage ? 'Complete' : 'Missing',
      laborordnung: supervisor.laborordnungState,
      supervisorAssignments: assignmentCount?.supervisorCount ?? 0,
      traineeAssignments: assignmentCount?.traineeCount ?? 0,
    };
  });
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const hasActiveFilters = selectedProfilePictureStatuses.length > 0
    || selectedLabRulesStatuses.length > 0;
  const filteredRows = rows.filter((row) => {
    if (normalizedSearch && !row.name.toLocaleLowerCase().includes(normalizedSearch)) {
      return false;
    }
    if (
      selectedProfilePictureStatuses.length > 0
      && !selectedProfilePictureStatuses.some((option) => option.label === row.photo)
    ) {
      return false;
    }
    if (
      selectedLabRulesStatuses.length > 0
      && !selectedLabRulesStatuses.some((option) => option.value === row.laborordnung)
    ) {
      return false;
    }
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleRows = filteredRows.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  return (
    <PageShell
      title="Supervisor staffing"
      breadcrumbs={[
        ...(canOpenPeople ? [{ label: 'Directory', to: '/people' }] : [{ label: 'Directory' }]),
        { label: 'Members' },
      ]}
      description="Profile-picture readiness, Lab Rules status, and staffing across active Open Day periods."
      width="wide"
      className="supervisor-staffing-page"
    >
      <section className="supervisor-staffing-main" aria-label="Members table">
          {dashboard.periods.length === 0 && (
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="No active staffing periods"
              subtitle="Members are shown without assignment totals."
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
                    <Button
                      hasIconOnly
                      kind={hasActiveFilters ? 'primary' : 'ghost'}
                      size="md"
                      renderIcon={Filter}
                      iconDescription="Filters"
                      aria-expanded={filtersOpen}
                      aria-controls="members-filters"
                      onClick={() => setFiltersOpen((open) => !open)}
                    />
                    <Dropdown
                      id="members-period-selector"
                      className="supervisor-staffing-period-selector"
                      titleText="Open Days period"
                      hideLabel
                      size="lg"
                      label={dashboard.periods.length === 0 ? 'No active periods' : 'Select a period'}
                      items={dashboard.periods}
                      itemToString={(period) => period?.name ?? ''}
                      selectedItem={selectedPeriod}
                      disabled={dashboard.periods.length === 0}
                      onChange={({ selectedItem }) => {
                        setSelectedPeriodId(selectedItem?.id ?? null);
                        setPage(1);
                      }}
                    />
                    {canOpenPeople && (
                      <Button kind="tertiary" onClick={() => navigate('/people')}>
                        Directory
                      </Button>
                    )}
                  </TableToolbarContent>
                </TableToolbar>
                {filtersOpen && (
                  <div
                    id="members-filters"
                    className="people-filter-panel"
                    role="region"
                    aria-label="Members filters"
                  >
                    <div className="people-filter-panel__fields">
                      <MultiSelect
                        id="members-profile-picture-filter"
                        className="people-filter-panel__field"
                        titleText="Profile picture"
                        label="All profile-picture statuses"
                        items={PROFILE_PICTURE_STATUS_OPTIONS}
                        itemToString={(option) => option?.label ?? ''}
                        selectedItems={selectedProfilePictureStatuses}
                        onChange={({ selectedItems }) => {
                          setSelectedProfilePictureStatuses(selectedItems ?? []);
                          setPage(1);
                        }}
                      />
                      <MultiSelect
                        id="members-lab-rules-filter"
                        className="people-filter-panel__field"
                        titleText="Lab Rules"
                        label="All Lab Rules statuses"
                        items={LAB_RULES_STATUS_OPTIONS}
                        itemToString={(option) => option?.label ?? ''}
                        selectedItems={selectedLabRulesStatuses}
                        onChange={({ selectedItems }) => {
                          setSelectedLabRulesStatuses(selectedItems ?? []);
                          setPage(1);
                        }}
                      />
                      <Button
                        kind="ghost"
                        size="md"
                        disabled={!hasActiveFilters}
                        onClick={() => {
                          setSelectedProfilePictureStatuses([]);
                          setSelectedLabRulesStatuses([]);
                          setPage(1);
                        }}
                      >
                        Clear filters
                      </Button>
                    </div>
                  </div>
                )}
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
