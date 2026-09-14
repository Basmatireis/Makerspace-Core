import { useState } from 'react';
import { Edit, Repeat } from '@carbon/icons-react';
import { Button, ContentSwitcher, DataTable, InlineNotification, Stack, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { archiveOpenDayPeriod, getOpenDayCalendarContext, openOpenDayPeriodForStaffing, publishOpenDayPeriod } from '../../api/generated/open-days/open-days';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { longDate, staffingLabel, statusTagType, timeRange } from './format';
import { openDayKeys, scheduleQueryOptions } from './queries';
import { SemesterCalendar } from './SemesterCalendar';

export function OpenDayPeriodPage() {
  const { periodId = '' } = useParams();
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [view, setView] = useState<'table' | 'calendar'>('calendar');
  const scheduleQuery = useQuery(scheduleQueryOptions(periodId));
  const contextQuery = useQuery({ queryKey: [...openDayKeys.schedule(periodId), 'context'], queryFn: ({ signal }) => getOpenDayCalendarContext(periodId, { signal }), enabled: Boolean(periodId) });
  const lifecycleMutation = useMutation({
    mutationFn: async (target: 'staffing' | 'published' | 'archived') => {
      const period = scheduleQuery.data!.period;
      if (target === 'staffing') return openOpenDayPeriodForStaffing(period.id, { expectedVersion: period.version });
      if (target === 'published') return publishOpenDayPeriod(period.id, { expectedVersion: period.version });
      return archiveOpenDayPeriod(period.id, { expectedVersion: period.version });
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: openDayKeys.schedule(periodId) }),
        queryClient.invalidateQueries({ queryKey: openDayKeys.periods() }),
      ]);
    },
  });
  const canManage = hasPermission(currentUser, PermissionId.open_daysmanage);

  if (scheduleQuery.isPending) return <InlineLoadingState label="Loading Open Day period" />;
  if (scheduleQuery.isError || !scheduleQuery.data) return <ErrorState title="Unable to load this period" message="It may no longer be visible, or the connection failed." onRetry={() => void scheduleQuery.refetch()} />;
  const { period, items } = scheduleQuery.data;
  const next = period.status === 'draft' ? 'staffing' : period.status === 'staffing' ? 'published' : period.status === 'published' ? 'archived' : null;
  const rows = items.map((day) => ({ id: day.id, date: longDate(day.startsAt, scheduleQuery.data.timeZone), time: timeRange(day, scheduleQuery.data.timeZone), supervisors: requirementCount(day, 'supervisor'), trainees: requirementCount(day, 'trainee'), status: staffingLabel(day), assignment: day.myAssignment ? (day.requirements.find((item) => item.id === day.myAssignment?.requirementId)?.kind ?? 'Assigned') : '—' }));
  const headers = [{ key: 'date', header: 'Date' }, { key: 'time', header: 'Time' }, { key: 'supervisors', header: 'Supervisors' }, { key: 'trainees', header: 'Trainees' }, { key: 'status', header: 'Staffing status' }, { key: 'assignment', header: 'My assignment' }];

  return <Stack gap={6} className="open-day-period-page">
    <PageHeader title={period.name} breadcrumbs={[{ label: 'Open Days', to: '/open-days' }]} description={`${period.startsOn} – ${period.endsOn}`} actions={<>
      {canManage && period.status !== 'archived' && <Button kind="secondary" renderIcon={Repeat} onClick={() => navigate(`/open-days/${period.id}/schedule?recurrence=1`)}>Create recurring</Button>}
      {canManage && period.status !== 'archived' && <Button renderIcon={Edit} onClick={() => navigate(`/open-days/${period.id}/schedule`)}>Edit schedule</Button>}
      {canManage && next && <Button kind={next === 'archived' ? 'danger' : 'tertiary'} disabled={lifecycleMutation.isPending} onClick={() => lifecycleMutation.mutate(next)}>Move to {next}</Button>}
    </>} />
    <div className="period-summary-bar"><div><span>Period</span><strong>{period.name}</strong><Tag type={statusTagType(period.status)}>{period.status}</Tag></div><div className="period-summary-bar__stats"><span><strong>{period.totalOpenDays}</strong>Total</span><span><strong className="status-good">{period.fullyStaffedCount}</strong>Fully staffed</span><span><strong className="status-bad">{period.needsStaffCount}</strong>Needs staff</span></div></div>
    {lifecycleMutation.isError && <InlineNotification kind="error" lowContrast title="Status change failed" subtitle="The period may have changed. Reload and try again." onCloseButtonClick={() => lifecycleMutation.reset()} />}
    <div className="period-view-toolbar"><ContentSwitcher selectedIndex={view === 'table' ? 0 : 1} onChange={({ index }) => setView(index === 0 ? 'table' : 'calendar')} size="sm"><Switch name="table" text="Table" /><Switch name="calendar" text="Calendar" /></ContentSwitcher></div>
    {view === 'calendar' ? (
      <>
        <div className="calendar-legend"><span className="legend-good">Fully staffed</span><span className="legend-bad">Needs staff</span><span className="legend-cancelled">Cancelled</span><span className="legend-mine">Your assignment</span><span className="legend-context">Holiday / break</span></div>
        <SemesterCalendar startsOn={period.startsOn} endsOn={period.endsOn} days={items} entries={contextQuery.data?.entries} timeZone={scheduleQuery.data.timeZone} onOpenDay={(day) => navigate(`/open-days/${period.id}/days/${day.id}`)} />
      </>
    ) : (
      <div className="responsive-table">
        <DataTable rows={rows} headers={headers}>
          {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
            <TableContainer title="Open Days">
              <Table {...getTableProps()}>
                <TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead>
                <TableBody>{tableRows.map((row) => <TableRow {...getRowProps({ row })} key={row.id} onClick={() => navigate(`/open-days/${period.id}/days/${row.id}`)}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'status' ? <Tag type={statusTagType(String(cell.value))}>{String(cell.value)}</Tag> : String(cell.value)}</TableCell>)}</TableRow>)}</TableBody>
              </Table>
            </TableContainer>
          )}
        </DataTable>
      </div>
    )}
  </Stack>;
}

function requirementCount(day: { requirements: Array<{ kind: string; assignedCount: number; requiredCount: number }> }, kind: string) {
  const item = day.requirements.find((requirement) => requirement.kind === kind);
  return item ? `${item.assignedCount} / ${item.requiredCount}` : '0 / 0';
}
