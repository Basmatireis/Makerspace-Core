import './styles.scss';
import { useLatestCallback } from '../../app/useLatestCallback';
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
  Tile,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useNavigate } from 'react-router-dom';
import { deleteOpenDayPeriod, updateOpenDayPeriod } from '../../api/generated/open-days/open-days';
import type { OpenDayPeriod } from '../../api/generated/models';
import { DateInput } from '../../app/DateInput';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useOpenDaysLayout } from './useOpenDaysLayout';
import { RowActions } from '../../app/RowActions';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { CreateOpenDayPeriodWizard } from './CreateOpenDayPeriodWizard';
import { periodRange, signUpDeadlineLabel, statusTagType } from './format';
import { openDaySchedulePath } from './paths';
import { openDayKeys, periodsQueryOptions } from './queries';

type PeriodDraft = Pick<OpenDayPeriod, 'id' | 'name' | 'startsOn' | 'endsOn' | 'status' | 'version'> & {
  signUpDeadline: string;
};

function periodToDraft(period: OpenDayPeriod): PeriodDraft {
  return { ...period, signUpDeadline: period.signUpDeadline ?? '' };
}

// Outside draft only the sign-up deadline can change; archived periods are final.
function editPeriodLabel(period: OpenDayPeriod) {
  return period.status === 'draft' || period.status === 'archived' ? 'Edit metadata' : 'Edit sign-up deadline';
}

function editPeriodTitle(period: OpenDayPeriod) {
  return period.status === 'archived' ? 'Archived periods cannot be edited' : editPeriodLabel(period);
}

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
  const { isPhone } = useOpenDaysLayout();
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createDirty, setCreateDirty] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [periodDraft, setPeriodDraft] = useState<PeriodDraft | null>(null);
  const [deletePeriod, setDeletePeriod] = useState<OpenDayPeriod | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(pageSizes[0]);
  const periodsQuery = useQuery(periodsQueryOptions());
  const originalPeriod = periodsQuery.data?.items.find((period) => period.id === periodDraft?.id);
  const periodDirty = Boolean(
    periodDraft &&
    originalPeriod &&
    (['name', 'startsOn', 'endsOn'].some(
      (key) => periodDraft[key as keyof PeriodDraft] !== originalPeriod[key as keyof PeriodDraft],
    ) ||
      periodDraft.signUpDeadline !== (originalPeriod.signUpDeadline ?? '')),
  );
  const signUpDeadlineInvalid = Boolean(
    periodDraft?.signUpDeadline &&
    (periodDraft.signUpDeadline < periodDraft.startsOn || periodDraft.signUpDeadline > periodDraft.endsOn),
  );
  const guard = useUnsavedChanges({
    isDirty: periodDirty || (createOpen && createDirty),
    onDiscard: () => {
      setPeriodDraft(null);
      setCreateOpen(false);
      setCreateDirty(false);
    },
  });
  const canManage = hasPermission(currentUser, PermissionId.open_daysmanage);
  const periodMutation = useMutation({
    mutationFn: (value: PeriodDraft) =>
      updateOpenDayPeriod(value.id, {
        name: value.name,
        startsOn: value.startsOn,
        endsOn: value.endsOn,
        signUpDeadline: value.signUpDeadline || null,
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
  const requestFormClose = useLatestCallback(() => {
    if (!periodMutation.isPending)
      guard.requestDiscard(() => {
        setPeriodDraft(null);
        periodMutation.reset();
      });
  });
  const periods = periodsQuery.data?.items ?? [];
  const activePeriods = periods.filter((period) => period.status === 'staffing' || period.status === 'published');
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredPeriods = normalizedSearch
    ? periods.filter((period) =>
        [
          period.name,
          periodRange(period),
          period.status,
          period.totalOpenDays,
          period.openSupervisorPositions,
          period.myAssignmentCount,
          period.cancelledCount,
        ].some((value) => String(value).toLocaleLowerCase().includes(normalizedSearch)),
      )
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

  if (periodsQuery.data && !canManage && activePeriods.length === 1) {
    return <Navigate to={`/open-days/${activePeriods[0].id}`} replace />;
  }

  return (
    <PageShell
      title="Open Days"
      description="Plan schedules, coordinate staffing, and see your assignments."
      className="open-days-page"
    >
      {periodsQuery.isPending && <InlineLoadingState label="Loading Open Day periods" />}
      {periodsQuery.isError && (
        <ErrorState
          title="Unable to load Open Days"
          message="Check the connection and try again."
          onRetry={() => void periodsQuery.refetch()}
        />
      )}
      {(periodMutation.isError || deleteMutation.isError) && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Period change was not saved"
          subtitle="The period may have changed. Reload and try again."
        />
      )}
      {periodsQuery.data && (
        <section className="periods-table-section" aria-labelledby="periods-heading">
          <h2 id="periods-heading" className="open-days-section-title">
            Periods
          </h2>
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
                      onChange={(_event, value) => {
                        setSearch(value ?? '');
                        setPage(1);
                      }}
                      onClear={() => {
                        setSearch('');
                        setPage(1);
                      }}
                    />
                    {canManage && (
                      <Button kind="secondary" renderIcon={CalendarIcon} onClick={() => navigate('/open-days/manage')}>
                        Breaks
                      </Button>
                    )}
                    {canManage && (
                      <Button renderIcon={Add} onClick={() => setCreateOpen(true)}>
                        Create
                      </Button>
                    )}
                  </TableToolbarContent>
                </TableToolbar>
                {!isPhone && (
                  <Table {...getTableProps()} size="lg" aria-label="Open Day periods">
                    <TableHead>
                      <TableRow>
                        {headers.map((header) => (
                          <TableHeader
                            {...getHeaderProps({ header })}
                            key={header.key}
                            className={header.key === 'actions' ? 'period-table__actions-column' : undefined}
                          >
                            {header.header}
                          </TableHeader>
                        ))}
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {tableRows.map((row) => {
                        const period = periodsById.get(row.id);
                        if (!period) return null;
                        return (
                          <TableRow {...getRowProps({ row })} key={row.id}>
                            {row.cells.map((cell) => (
                              <TableCell
                                key={cell.id}
                                className={
                                  cell.info.header === 'actions'
                                    ? 'period-table__actions-column'
                                    : cell.info.header.endsWith('Count') ||
                                        cell.info.header === 'totalOpenDays' ||
                                        cell.info.header === 'openSupervisorPositions'
                                      ? 'period-table__metric'
                                      : undefined
                                }
                              >
                                {cell.info.header === 'period' ? (
                                  <span className="period-table__period">
                                    <CarbonLink
                                      href={`/open-days/${period.id}`}
                                      onClick={(event) => {
                                        event.preventDefault();
                                        navigate(`/open-days/${period.id}`);
                                      }}
                                    >
                                      {period.name}
                                    </CarbonLink>
                                    <span>{periodRange(period)}</span>
                                    {period.signUpDeadline && <span>{signUpDeadlineLabel(period)}</span>}
                                  </span>
                                ) : cell.info.header === 'status' ? (
                                  <Tag type={statusTagType(period.status)}>{period.status}</Tag>
                                ) : cell.info.header === 'openSupervisorPositions' ? (
                                  <span className={period.openSupervisorPositions > 0 ? 'status-bad' : 'status-good'}>
                                    {period.openSupervisorPositions}
                                  </span>
                                ) : cell.info.header === 'actions' && canManage ? (
                                  <div className="period-table__actions">
                                    <Button
                                      kind="ghost"
                                      size="sm"
                                      renderIcon={Edit}
                                      title={editPeriodTitle(period)}
                                      disabled={period.status === 'archived'}
                                      onClick={() => setPeriodDraft(periodToDraft(period))}
                                    >
                                      {editPeriodLabel(period)}
                                    </Button>
                                    <Button
                                      hasIconOnly
                                      kind="danger--ghost"
                                      size="sm"
                                      renderIcon={TrashCan}
                                      iconDescription={`Delete ${period.name}`}
                                      title="Delete period"
                                      onClick={() => setDeletePeriod(period)}
                                    />
                                  </div>
                                ) : cell.info.header === 'actions' ? (
                                  '—'
                                ) : (
                                  String(cell.value)
                                )}
                              </TableCell>
                            ))}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
                {isPhone && (
                  <div className="open-day-period-cards" aria-label="Open Day periods">
                    {visiblePeriods.map((period) => (
                      <Tile key={period.id} className="open-day-period-card">
                        <div className="open-day-period-card__heading">
                          <CarbonLink
                            href={`/open-days/${period.id}`}
                            onClick={(event) => {
                              event.preventDefault();
                              navigate(`/open-days/${period.id}`);
                            }}
                          >
                            {period.name}
                          </CarbonLink>
                          <Tag type={statusTagType(period.status)}>{period.status}</Tag>
                        </div>
                        <p>{periodRange(period)}</p>
                        {period.signUpDeadline && <p>{signUpDeadlineLabel(period)}</p>}
                        <dl>
                          <div>
                            <dt>Open Days</dt>
                            <dd>{period.totalOpenDays}</dd>
                          </div>
                          <div>
                            <dt>Open supervisor positions</dt>
                            <dd className={period.openSupervisorPositions > 0 ? 'status-bad' : 'status-good'}>
                              {period.openSupervisorPositions}
                            </dd>
                          </div>
                          <div>
                            <dt>Your assignments</dt>
                            <dd>{period.myAssignmentCount}</dd>
                          </div>
                          <div>
                            <dt>Cancelled</dt>
                            <dd>{period.cancelledCount}</dd>
                          </div>
                        </dl>
                        {canManage && (
                          <RowActions label={`Actions for ${period.name}`}>
                            <Button
                              kind="ghost"
                              size="sm"
                              renderIcon={Edit}
                              disabled={period.status === 'archived'}
                              onClick={() => setPeriodDraft(periodToDraft(period))}
                            >
                              {editPeriodLabel(period)}
                            </Button>
                            <Button
                              kind="danger--ghost"
                              size="sm"
                              renderIcon={TrashCan}
                              onClick={() => setDeletePeriod(period)}
                            >
                              Delete
                            </Button>
                          </RowActions>
                        )}
                      </Tile>
                    ))}
                  </div>
                )}
                {filteredPeriods.length === 0 && (
                  <div className="empty-state">
                    <h2>{search ? 'No matching periods' : canManage ? 'No periods yet' : 'No visible periods'}</h2>
                    <p>
                      {search
                        ? 'Try a different search term.'
                        : canManage
                          ? 'Create a period to start planning Open Days.'
                          : 'Open Day periods will appear here when staffing opens.'}
                    </p>
                  </div>
                )}
                <Pagination
                  page={currentPage}
                  pageSize={pageSize}
                  pageSizes={pageSizes}
                  totalItems={filteredPeriods.length}
                  onChange={({ page: nextPage, pageSize: nextPageSize }) => {
                    setPage(nextPage);
                    setPageSize(nextPageSize);
                  }}
                />
              </TableContainer>
            )}
          </DataTable>
        </section>
      )}
      {createOpen && (
        <CreateOpenDayPeriodWizard
          open={createOpen && !guard.dialogOpen}
          onDirtyChange={setCreateDirty}
          onClose={() => setCreateOpen(false)}
          onCreated={(periodId) => {
            setCreateOpen(false);
            guard.bypassAfterSubmit(() => navigate(openDaySchedulePath(periodId)));
          }}
        />
      )}
      <Modal
        open={Boolean(periodDraft) && !guard.dialogOpen}
        modalHeading={periodDraft?.status === 'draft' ? 'Edit period metadata' : 'Edit sign-up deadline'}
        primaryButtonText="Save period"
        secondaryButtonText="Cancel"
        primaryButtonDisabled={
          periodMutation.isPending ||
          !periodDraft?.name.trim() ||
          !periodDraft.startsOn ||
          !periodDraft.endsOn ||
          signUpDeadlineInvalid
        }
        onRequestClose={requestFormClose}
        onRequestSubmit={() => periodDraft && !periodMutation.isPending && periodMutation.mutate(periodDraft)}
      >
        {periodDraft && (
          <Stack gap={5}>
            {periodMutation.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Period was not saved"
                subtitle="Your inputs are kept. The period may have changed; review and try again."
              />
            )}
            {periodDraft.status !== 'draft' && (
              <p>Name and dates are fixed once staffing has started. Only the sign-up deadline can change.</p>
            )}
            <TextInput
              id="period-name"
              labelText="Name"
              readOnly={periodDraft.status !== 'draft'}
              value={periodDraft.name}
              onChange={(event) => setPeriodDraft({ ...periodDraft, name: event.target.value })}
            />
            <DateInput
              id="period-start"
              readOnly={periodDraft.status !== 'draft'}
              labelText="Start date"
              value={periodDraft.startsOn}
              onChange={(startsOn) => setPeriodDraft({ ...periodDraft, startsOn })}
            />
            <DateInput
              id="period-end"
              readOnly={periodDraft.status !== 'draft'}
              labelText="End date"
              value={periodDraft.endsOn}
              onChange={(endsOn) => setPeriodDraft({ ...periodDraft, endsOn })}
            />
            <DateInput
              id="period-sign-up-deadline"
              labelText="Sign-up deadline (optional)"
              helperText="Supervisors see this date on their dashboard as the deadline for their open-day minimum. Empty uses the period's end date."
              value={periodDraft.signUpDeadline}
              invalid={signUpDeadlineInvalid}
              invalidText="Sign-up deadline must lie within the period."
              onChange={(signUpDeadline) => setPeriodDraft({ ...periodDraft, signUpDeadline })}
            />
          </Stack>
        )}
      </Modal>
      <DestructiveActionDialog
        open={Boolean(deletePeriod)}
        title="Delete period?"
        confirmLabel="Delete period"
        pending={deleteMutation.isPending}
        error={deleteMutation.isError ? 'The period may have changed. Reload and try again.' : undefined}
        onClose={() => {
          setDeletePeriod(null);
          deleteMutation.reset();
        }}
        onConfirm={() => deletePeriod && deleteMutation.mutate(deletePeriod)}
      >
        <p>
          <strong>{deletePeriod?.name}</strong> and all its Open Days, staffing requirements, eligibility role rules,
          and assignments will be permanently deleted. Audit history is retained. This cannot be undone.
        </p>
      </DestructiveActionDialog>
      <UnsavedChangesDialog guard={guard} />
    </PageShell>
  );
}
