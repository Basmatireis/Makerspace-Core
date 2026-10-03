import { useState } from 'react';
import { Calendar as CalendarIcon, Edit, List } from '@carbon/icons-react';
import { Button, DataTable, Dropdown, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, Tag } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { dateInTimeZone, timeInTimeZone } from './dateTime';
import { longDate, periodRange, statusTagType, timeRange } from './format';
import { OpenDayDateTimeFilters } from './OpenDayDateTimeFilters';
import { OpenDayPeriodSummary } from './OpenDayPeriodSummary';
import { allOpenDayDateTimeFilters, filterOpenDaysByDateTime, type OpenDayDateTimeFilter } from './openDayDateTimeFilter';
import { filterOpenDays, openDayFilterOptions, type OpenDayFilter } from './openDayFilters';
import { openDaySchedulePath } from './paths';
import { calendarContextQueryOptions, scheduleQueryOptions } from './queries';
import { OpenDayRegistrationModal } from './OpenDayDetailPage';
import { ScheduleEditorPage } from './ScheduleEditorPage';
import { SemesterCalendar } from './SemesterCalendar';

export function OpenDayPeriodPage() {
  const { periodId = '' } = useParams();
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [view, setView] = useState<'table' | 'calendar'>('calendar');
  const [filter, setFilter] = useState<OpenDayFilter>('all');
  const [dateTimeFilter, setDateTimeFilter] = useState<OpenDayDateTimeFilter>(allOpenDayDateTimeFilters);
  const [selectedOpenDayId, setSelectedOpenDayId] = useState<string | null>(null);
  const scheduleQuery = useQuery(scheduleQueryOptions(periodId));
  const contextQuery = useQuery(calendarContextQueryOptions(periodId));
  const canManage = hasPermission(currentUser, PermissionId.open_daysmanage);

  if (scheduleQuery.isPending) return <InlineLoadingState label="Loading Open Day period" />;
  if (scheduleQuery.isError || !scheduleQuery.data) return <ErrorState title="Unable to load this period" message="It may no longer be visible, or the connection failed." onRetry={() => void scheduleQuery.refetch()} />;
  const { period, items } = scheduleQuery.data;
  if (params.get('mode') === 'edit' && canManage && period.status !== 'archived') return <ScheduleEditorPage />;
  const visibleItems = filterOpenDaysByDateTime(filterOpenDays(items, filter), dateTimeFilter, scheduleQuery.data.timeZone);
  const visibleItemsById = new Map(visibleItems.map((day) => [day.id, day]));
  const rows = visibleItems.map((day) => ({ id: day.id, date: dateInTimeZone(day.startsAt, scheduleQuery.data.timeZone), time: timeInTimeZone(day.startsAt, scheduleQuery.data.timeZone), supervisors: requirementCount(day, 'supervisor'), trainees: requirementCount(day, 'trainee'), assignment: day.myAssignment ? (day.requirements.find((item) => item.id === day.myAssignment?.requirementId)?.kind ?? 'Assigned') : '—' }));
  const headers = [{ key: 'date', header: 'Date' }, { key: 'time', header: 'Time' }, { key: 'supervisors', header: 'Supervisors' }, { key: 'trainees', header: 'Trainees' }, { key: 'assignment', header: 'My assignment' }];

  return <PageShell title={period.name} titleAdornment={<Tag type={statusTagType(period.status)}>{period.status}</Tag>} breadcrumbs={[{ label: 'Open Days', to: '/open-days' }, { label: period.name }]} description={periodRange(period)} actions={canManage && period.status !== 'archived' ? <Button renderIcon={Edit} onClick={() => navigate(openDaySchedulePath(period.id))}>Edit</Button> : undefined} width="wide" className="open-day-period-page">
    <OpenDayPeriodSummary period={period} />
    <DataTable rows={rows} headers={headers} isSortable>
      {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
        <TableContainer className="open-days-view-container">
          <OpenDayViewToolbar filter={filter} dateTimeFilter={dateTimeFilter} items={items} timeZone={scheduleQuery.data.timeZone} view={view} onFilter={setFilter} onDateTimeFilter={setDateTimeFilter} onView={setView} />
          {view === 'calendar' ? (
            <div className="open-days-view-content open-days-view-content--calendar">
              <SemesterCalendar startsOn={period.startsOn} endsOn={period.endsOn} days={visibleItems} entries={contextQuery.data?.entries} timeZone={scheduleQuery.data.timeZone} onOpenDay={(day) => setSelectedOpenDayId(day.id)} />
            </div>
          ) : (
            <div className="responsive-table open-days-view-content">
              <Table {...getTableProps()}>
                <TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header, isSortable: header.key === 'date' || header.key === 'time' })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead>
                <TableBody>{tableRows.map((row) => {
                  const day = visibleItemsById.get(row.id);
                  return <TableRow {...getRowProps({ row })} key={row.id} onClick={() => setSelectedOpenDayId(row.id)}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'date' && day ? longDate(day.startsAt, scheduleQuery.data.timeZone) : cell.info.header === 'time' && day ? timeRange(day, scheduleQuery.data.timeZone) : String(cell.value)}</TableCell>)}</TableRow>;
                })}</TableBody>
              </Table>
            </div>
          )}
        </TableContainer>
      )}
    </DataTable>
    {selectedOpenDayId && <OpenDayRegistrationModal periodId={period.id} periodStatus={period.status} openDayId={selectedOpenDayId} onRequestClose={() => setSelectedOpenDayId(null)} />}
  </PageShell>;
}

function OpenDayViewToolbar({ filter, dateTimeFilter, items, timeZone, view, onFilter, onDateTimeFilter, onView }: { filter: OpenDayFilter; dateTimeFilter: OpenDayDateTimeFilter; items: Array<{ startsAt: string }>; timeZone: string; view: 'table' | 'calendar'; onFilter: (filter: OpenDayFilter) => void; onDateTimeFilter: (filter: OpenDayDateTimeFilter) => void; onView: (view: 'table' | 'calendar') => void }) {
  return (
    <TableToolbar aria-label="Open Days tools" className="open-days-view-toolbar">
      <TableToolbarContent>
        <div className="open-days-view-toolbar__primary">
          <div className="open-days-view-toolbar__views" role="group" aria-label="Open Days view">
            <Button hasIconOnly kind={view === 'table' ? 'primary' : 'ghost'} size="md" renderIcon={List} iconDescription="Table view" aria-pressed={view === 'table'} onClick={() => onView('table')} />
            <Button hasIconOnly kind={view === 'calendar' ? 'primary' : 'ghost'} size="md" renderIcon={CalendarIcon} iconDescription="Calendar view" aria-pressed={view === 'calendar'} onClick={() => onView('calendar')} />
          </div>
          <OpenDayDateTimeFilters idPrefix="open-days" items={items} timeZone={timeZone} value={dateTimeFilter} onChange={onDateTimeFilter} />
        </div>
        <Dropdown
          id="open-days-availability-filter"
          className="open-days-view-toolbar__status-filter"
          titleText="Filter Open Days"
          hideLabel
          size="md"
          label="Choose Open Days"
          items={openDayFilterOptions}
          itemToString={(option) => option?.label ?? ''}
          selectedItem={openDayFilterOptions.find((option) => option.value === filter)}
          onChange={({ selectedItem }) => onFilter(selectedItem?.value ?? 'all')}
        />
      </TableToolbarContent>
    </TableToolbar>
  );
}

function requirementCount(day: { requirements: Array<{ kind: string; assignedCount: number; requiredCount: number }> }, kind: string) {
  const item = day.requirements.find((requirement) => requirement.kind === kind);
  return item ? `${item.assignedCount} / ${item.requiredCount}` : '0 / 0';
}
