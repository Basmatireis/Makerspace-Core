import { useState } from 'react';
import { Add, Calendar as CalendarIcon, Edit, TrashCan } from '@carbon/icons-react';
import {
  Button,
  DataTable,
  InlineNotification,
  Link as CarbonLink,
  Modal,
  Pagination,
  Stack,
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
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { deleteOpenDayPeriod, updateOpenDayPeriod } from '../../api/generated/open-days/open-days';
import type { OpenDayPeriod } from '../../api/generated/models';
import { DateInput } from '../../app/DateInput';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { CreateOpenDayPeriodWizard } from './CreateOpenDayPeriodWizard';
import { periodRange, statusTagType } from './format';
import { openDaySchedulePath } from './paths';
import { openDayKeys, periodsQueryOptions } from './queries';

type PeriodDraft = Pick<OpenDayPeriod, 'id' | 'name' | 'startsOn' | 'endsOn' | 'version'>;

const pageSizes = [10, 25, 50];
const periodHeaders = [
  { key: 'period', header: 'Period' },
  { key: 'status', header: 'Status' },
  { key: 'totalOpenDays', header: 'Open Days' },
  { key: 'openSupervisorPositions', header: 'Open supervisor positions' },
  { key: 'myAssignmentCount', header: 'Your assignments' },
  { key: 'cancelledCount', header: 'Cancelled' },
  { key: 'actions', header: 'Actions' },
];

export function OpenDaysPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [periodDraft, setPeriodDraft] = useState<PeriodDraft | null>(null);
  const [deletePeriod, setDeletePeriod] = useState<OpenDayPeriod | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(pageSizes[0]);
  const periodsQuery = useQuery(periodsQueryOptions());
  const canManage = hasPermission(currentUser, PermissionId.open_daysmanage);
  const periodMutation = useMutation({
    mutationFn: (value: PeriodDraft) => updateOpenDayPeriod(value.id, {
      name: value.name,
      startsOn: value.startsOn,
      endsOn: value.endsOn,
      expectedVersion: value.version,
    }),
    onSuccess: async () => {
      setPeriodDraft(null);
      await queryClient.invalidateQueries({ queryKey: openDayKeys.all });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (value: OpenDayPeriod) => deleteOpenDayPeriod(value.id, { expectedVersion: value.version }),
    onSuccess: async () => {
      setDeletePeriod(null);
      await queryClient.invalidateQueries({ queryKey: openDayKeys.all });
    },
  });
  const periods = periodsQuery.data?.items ?? [];
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredPeriods = normalizedSearch
    ? periods.filter((period) => [
        period.name,
        periodRange(period),
        period.status,
        period.totalOpenDays,
        period.openSupervisorPositions,
        period.myAssignmentCount,
        period.cancelledCount,
      ].some((value) => String(value).toLocaleLowerCase().includes(normalizedSearch)))
    : periods;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filteredPeriods.length / pageSize)));
  const visiblePeriods = filteredPeriods.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const rows = visiblePeriods.map((period) => ({
    id: period.id,
    period: period.name,
    status: period.status,
    totalOpenDays: period.totalOpenDays,
    openSupervisorPositions: period.openSupervisorPositions,
    myAssignmentCount: period.myAssignmentCount,
    cancelledCount: period.cancelledCount,
    actions: '',
  }));
  const periodsById = new Map(visiblePeriods.map((period) => [period.id, period]));

  return (
    <PageShell
      title="Open Days"
      description="Plan schedules, coordinate staffing, and see your assignments."
      className="open-days-page"
    >
      {periodsQuery.isPending && <InlineLoadingState label="Loading Open Day periods" />}
      {periodsQuery.isError && <ErrorState title="Unable to load Open Days" message="Check the connection and try again." onRetry={() => void periodsQuery.refetch()} />}
      {(periodMutation.isError || deleteMutation.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Period change was not saved" subtitle="The period may have changed. Reload and try again." />}
      {periodsQuery.data && (
        <section className="periods-table-section" aria-labelledby="periods-heading">
          <h2 id="periods-heading" className="open-days-section-title">Periods</h2>
          <DataTable key={visiblePeriods.map((period) => period.id).join('|')} rows={rows} headers={periodHeaders}>
            {({ rows: tableRows, headers, getHeaderProps, getRowProps, getTableProps }) => (
              <TableContainer className="open-day-periods-table">
                <TableToolbar aria-label="Periods table toolbar">
                  <TableToolbarContent>
                    <TableToolbarSearch
                      id="periods-search"
                      persistent
                      labelText="Search periods"
                      placeholder="Search periods"
                      value={search}
                      onChange={(_event, value) => { setSearch(value ?? ''); setPage(1); }}
                      onClear={() => { setSearch(''); setPage(1); }}
                    />
                    {canManage && <Button kind="secondary" renderIcon={CalendarIcon} onClick={() => navigate('/open-days/manage')}>Breaks</Button>}
                    {canManage && <Button renderIcon={Add} onClick={() => setCreateOpen(true)}>Create</Button>}
                  </TableToolbarContent>
                </TableToolbar>
                <Table {...getTableProps()} size="lg" aria-label="Open Day periods">
                  <TableHead>
                    <TableRow>
                      {headers.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key} className={header.key === 'actions' ? 'period-table__actions-column' : undefined}>{header.header}</TableHeader>)}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {tableRows.map((row) => {
                      const period = periodsById.get(row.id);
                      if (!period) return null;
                      return <TableRow {...getRowProps({ row })} key={row.id}>
                        {row.cells.map((cell) => <TableCell key={cell.id} className={cell.info.header === 'actions' ? 'period-table__actions-column' : cell.info.header.endsWith('Count') || cell.info.header === 'totalOpenDays' || cell.info.header === 'openSupervisorPositions' ? 'period-table__metric' : undefined}>
                          {cell.info.header === 'period' ? <span className="period-table__period"><CarbonLink href={`/open-days/${period.id}`} onClick={(event) => { event.preventDefault(); navigate(`/open-days/${period.id}`); }}>{period.name}</CarbonLink><span>{periodRange(period)}</span></span>
                            : cell.info.header === 'status' ? <Tag type={statusTagType(period.status)}>{period.status}</Tag>
                              : cell.info.header === 'openSupervisorPositions' ? <span className={period.openSupervisorPositions > 0 ? 'status-bad' : 'status-good'}>{period.openSupervisorPositions}</span>
                                : cell.info.header === 'actions' && canManage ? <div className="period-table__actions">
                                  <Button kind="ghost" size="sm" renderIcon={Edit} title={period.status === 'draft' ? 'Edit metadata' : 'Only draft period metadata can be edited'} disabled={period.status !== 'draft'} onClick={() => setPeriodDraft(period)}>Edit metadata</Button>
                                  <Button hasIconOnly kind="danger--ghost" size="sm" renderIcon={TrashCan} iconDescription={`Delete ${period.name}`} title="Delete period" onClick={() => setDeletePeriod(period)} />
                                </div> : cell.info.header === 'actions' ? '—' : String(cell.value)}
                        </TableCell>)}
                      </TableRow>;
                    })}
                  </TableBody>
                </Table>
                {filteredPeriods.length === 0 && <div className="empty-state">
                  <h2>{search ? 'No matching periods' : canManage ? 'No periods yet' : 'No visible periods'}</h2>
                  <p>{search ? 'Try a different search term.' : canManage ? 'Create a period to start planning Open Days.' : 'Open Day periods will appear here when staffing opens.'}</p>
                </div>}
                <Pagination
                  page={currentPage}
                  pageSize={pageSize}
                  pageSizes={pageSizes}
                  totalItems={filteredPeriods.length}
                  onChange={({ page: nextPage, pageSize: nextPageSize }) => { setPage(nextPage); setPageSize(nextPageSize); }}
                />
              </TableContainer>
            )}
          </DataTable>
        </section>
      )}
      {createOpen && <CreateOpenDayPeriodWizard
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(periodId, defaults) => {
          setCreateOpen(false);
          navigate(openDaySchedulePath(periodId), { state: { openDayDefaults: defaults } });
        }}
      />}
      <Modal
        open={Boolean(periodDraft)}
        modalHeading="Edit period metadata"
        primaryButtonText="Save period"
        secondaryButtonText="Cancel"
        primaryButtonDisabled={periodMutation.isPending || !periodDraft?.name.trim() || !periodDraft.startsOn || !periodDraft.endsOn}
        onRequestClose={() => setPeriodDraft(null)}
        onRequestSubmit={() => periodDraft && periodMutation.mutate(periodDraft)}
      >
        {periodDraft && <Stack gap={5}>
          <TextInput id="period-name" labelText="Name" value={periodDraft.name} onChange={(event) => setPeriodDraft({ ...periodDraft, name: event.target.value })} />
          <DateInput id="period-start" labelText="Start date" value={periodDraft.startsOn} onChange={(startsOn) => setPeriodDraft({ ...periodDraft, startsOn })} />
          <DateInput id="period-end" labelText="End date" value={periodDraft.endsOn} onChange={(endsOn) => setPeriodDraft({ ...periodDraft, endsOn })} />
        </Stack>}
      </Modal>
      <Modal
        open={Boolean(deletePeriod)}
        danger
        modalHeading="Delete period?"
        primaryButtonText="Delete period"
        secondaryButtonText="Cancel"
        primaryButtonDisabled={deleteMutation.isPending}
        onRequestClose={() => setDeletePeriod(null)}
        onRequestSubmit={() => deletePeriod && deleteMutation.mutate(deletePeriod)}
      >
        <p>{deletePeriod?.name}, all of its Open Days, and all assignments will be permanently deleted. This cannot be undone.</p>
      </Modal>
    </PageShell>
  );
}
