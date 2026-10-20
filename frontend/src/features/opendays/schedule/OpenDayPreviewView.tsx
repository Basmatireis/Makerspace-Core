import { useState } from 'react';
import { Calendar as CalendarIcon, Edit, Filter, List } from '@carbon/icons-react';
import {
  Button,
  DataTable,
  Dropdown,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
} from '@carbon/react';
import type { CalendarEntry, OpenDay } from '../../../api/generated/models';
import { dateInTimeZone, timeInTimeZone } from '../dateTime';
import { longDate, timeRange } from '../format';
import { OpenDayDateTimeFilters } from '../OpenDayDateTimeFilters';
import { filterOpenDaysByDateTime, type OpenDayDateTimeFilter } from '../openDayDateTimeFilter';
import { filterOpenDays, openDayFilterOptions, type OpenDayFilter } from '../openDayFilters';
import { SemesterCalendar } from '../SemesterCalendar';
import { OpenDayAgenda, type AgendaItem } from '../OpenDayAgenda';
import { previewRequirementCount } from './scheduleHelpers';
import { SelectedCalendarContext } from './SelectedCalendarContext';

export function OpenDayPreviewView({
  filter,
  dateTimeFilter,
  items,
  timeZone,
  view,
  isPhone,
  canEdit,
  period,
  entries,
  onFilter,
  onDateTimeFilter,
  onView,
  onEdit,
  onOpenDay,
}: {
  filter: OpenDayFilter;
  dateTimeFilter: OpenDayDateTimeFilter;
  items: OpenDay[];
  timeZone: string;
  view: 'list' | 'calendar';
  isPhone: boolean;
  canEdit: boolean;
  period: { startsOn: string; endsOn: string };
  entries: CalendarEntry[];
  onFilter: (filter: OpenDayFilter) => void;
  onDateTimeFilter: (filter: OpenDayDateTimeFilter) => void;
  onView: (view: 'list' | 'calendar') => void;
  onEdit: () => void;
  onOpenDay: (day: OpenDay) => void;
}) {
  const [selectedDate, setSelectedDate] = useState<string | undefined>();
  const visibleItems = filterOpenDaysByDateTime(filterOpenDays(items, filter), dateTimeFilter, timeZone);
  const agendaItems: AgendaItem[] = visibleItems.map((day) => ({
    id: day.id,
    startsAt: day.startsAt,
    endsAt: day.endsAt,
    status: day.status,
    summary: timeRange(day, timeZone),
    details: (
      <>
        <span>{previewRequirementCount(day, 'supervisor')} supervisors</span>
        <span>{previewRequirementCount(day, 'trainee')} trainees</span>
        {day.myAssignment && <strong>Your assignment</strong>}
      </>
    ),
  }));
  const visibleItemsById = new Map(visibleItems.map((day) => [day.id, day]));
  const rows = visibleItems.map((day) => ({
    id: day.id,
    date: dateInTimeZone(day.startsAt, timeZone),
    time: timeInTimeZone(day.startsAt, timeZone),
    supervisors: previewRequirementCount(day, 'supervisor'),
    trainees: previewRequirementCount(day, 'trainee'),
    assignment: day.myAssignment
      ? (day.requirements.find((item) => item.id === day.myAssignment?.requirementId)?.kind ?? 'Assigned')
      : '—',
  }));
  const headers = [
    { key: 'date', header: 'Date' },
    { key: 'time', header: 'Time' },
    { key: 'supervisors', header: 'Supervisors' },
    { key: 'trainees', header: 'Trainees' },
    { key: 'assignment', header: 'My assignment' },
  ];

  return (
    <DataTable rows={rows} headers={headers} isSortable>
      {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
        <TableContainer className="open-days-view-container">
          <OpenDayPreviewToolbar
            filter={filter}
            dateTimeFilter={dateTimeFilter}
            items={items}
            timeZone={timeZone}
            view={view}
            canEdit={canEdit}
            onFilter={onFilter}
            onDateTimeFilter={onDateTimeFilter}
            onView={onView}
            onEdit={onEdit}
          />
          {view === 'calendar' ? (
            <div className="open-days-view-content open-days-view-content--calendar">
              <SemesterCalendar
                startsOn={period.startsOn}
                endsOn={period.endsOn}
                days={visibleItems}
                entries={entries}
                timeZone={timeZone}
                onOpenDay={onOpenDay}
                compact={isPhone}
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
              />
              {isPhone && selectedDate && (
                <>
                  <SelectedCalendarContext date={selectedDate} entries={entries} />
                  <OpenDayAgenda
                    items={agendaItems.filter((item) => dateInTimeZone(item.startsAt, timeZone) === selectedDate)}
                    timeZone={timeZone}
                    emptyMessage="No Open Days on this date."
                    onOpen={(id) => {
                      const day = visibleItemsById.get(id);
                      if (day) onOpenDay(day);
                    }}
                  />
                </>
              )}
            </div>
          ) : isPhone ? (
            <OpenDayAgenda
              items={agendaItems}
              timeZone={timeZone}
              emptyMessage="No Open Days match these filters."
              onOpen={(id) => {
                const day = visibleItemsById.get(id);
                if (day) onOpenDay(day);
              }}
            />
          ) : (
            <div className="responsive-table open-days-view-content">
              <Table {...getTableProps()}>
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((header) => (
                      <TableHeader
                        {...getHeaderProps({ header, isSortable: header.key === 'date' || header.key === 'time' })}
                        key={header.key}
                      >
                        {header.header}
                      </TableHeader>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tableRows.map((row) => {
                    const day = visibleItemsById.get(row.id);
                    return (
                      <TableRow
                        {...getRowProps({ row })}
                        key={row.id}
                        onClick={() => {
                          if (day) onOpenDay(day);
                        }}
                      >
                        {row.cells.map((cell) => (
                          <TableCell key={cell.id}>
                            {cell.info.header === 'date' && day ? (
                              <Button
                                kind="ghost"
                                size="sm"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  onOpenDay(day);
                                }}
                              >
                                {longDate(day.startsAt, timeZone)}
                              </Button>
                            ) : cell.info.header === 'time' && day ? (
                              timeRange(day, timeZone)
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
            </div>
          )}
        </TableContainer>
      )}
    </DataTable>
  );
}

function OpenDayPreviewToolbar({
  filter,
  dateTimeFilter,
  items,
  timeZone,
  view,
  canEdit,
  onFilter,
  onDateTimeFilter,
  onView,
  onEdit,
}: {
  filter: OpenDayFilter;
  dateTimeFilter: OpenDayDateTimeFilter;
  items: Array<{ startsAt: string }>;
  timeZone: string;
  view: 'list' | 'calendar';
  canEdit: boolean;
  onFilter: (filter: OpenDayFilter) => void;
  onDateTimeFilter: (filter: OpenDayDateTimeFilter) => void;
  onView: (view: 'list' | 'calendar') => void;
  onEdit: () => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  return (
    <>
      <div className="open-days-view-toolbar">
        <TableToolbar aria-label="Open Days tools">
          <TableToolbarContent>
            <div className="open-days-view-toolbar__actions">
              <Button
                hasIconOnly
                kind="ghost"
                size="md"
                renderIcon={Filter}
                iconDescription="Filter"
                aria-expanded={filtersOpen}
                aria-controls="open-days-filters"
                onClick={() => setFiltersOpen((open) => !open)}
              />
              {canEdit && (
                <Button
                  hasIconOnly
                  kind="secondary"
                  size="md"
                  renderIcon={Edit}
                  iconDescription="Edit"
                  onClick={onEdit}
                />
              )}
              <Button
                hasIconOnly
                kind="ghost"
                size="md"
                renderIcon={view === 'calendar' ? List : CalendarIcon}
                iconDescription={view === 'calendar' ? 'List view' : 'Calendar view'}
                onClick={() => onView(view === 'calendar' ? 'list' : 'calendar')}
              />
            </div>
          </TableToolbarContent>
        </TableToolbar>
      </div>
      {filtersOpen && (
        <div id="open-days-filters" className="open-days-filter-panel">
          <div className="open-days-filter-panel__fields">
            <OpenDayDateTimeFilters
              idPrefix="open-days"
              items={items}
              timeZone={timeZone}
              value={dateTimeFilter}
              onChange={onDateTimeFilter}
            />
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
          </div>
        </div>
      )}
    </>
  );
}
