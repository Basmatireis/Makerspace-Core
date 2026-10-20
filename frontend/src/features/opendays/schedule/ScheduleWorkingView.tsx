import { useState } from 'react';
import {
  Add,
  Calendar as CalendarIcon,
  Edit,
  Filter,
  List,
  Misuse,
  Save,
  TrashCan,
  Undo,
  View,
} from '@carbon/icons-react';
import {
  Button,
  DataTable,
  Table,
  TableBatchAction,
  TableBatchActions,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableSelectAll,
  TableSelectRow,
  TableToolbar,
  TableToolbarContent,
} from '@carbon/react';
import type { CalendarEntry, OpenDayPeriodStatus } from '../../../api/generated/models';
import { formatDate } from '../../../app/dateTime';
import { CalendarLegend } from '../CalendarLegend';
import { type WorkingSlot } from '../scheduleState';
import { dateInTimeZone, timeInTimeZone } from '../dateTime';
import { longDate, timeRange } from '../format';
import { OpenDayDateTimeFilters } from '../OpenDayDateTimeFilters';
import { filterOpenDaysByDateTime, type OpenDayDateTimeFilter } from '../openDayDateTimeFilter';
import { CalendarDayCell, SemesterCalendarGrid } from '../SemesterCalendarGrid';
import { OpenDayAgenda, type AgendaItem } from '../OpenDayAgenda';
import { DropDate } from './DraggableSlot';
import { workingRequirementCount, removalButtonLabel } from './scheduleHelpers';
import { SelectedCalendarContext } from './SelectedCalendarContext';

export function ScheduleWorkingView({
  view,
  isPhone,
  disableDrag,
  onView,
  dateTimeFilter,
  onDateTimeFilter,
  slots,
  startsOn,
  endsOn,
  entries,
  timeZone,
  periodStatus,
  dirty,
  canUndo,
  lifecyclePending,
  savePending,
  onUndo,
  onSave,
  onCreate,
  onPreview,
  onAdd,
  onEdit,
  onRemove,
  onBulkEdit,
}: {
  view: 'list' | 'calendar';
  isPhone: boolean;
  disableDrag: boolean;
  onView: (view: 'list' | 'calendar') => void;
  dateTimeFilter: OpenDayDateTimeFilter;
  onDateTimeFilter: (filter: OpenDayDateTimeFilter) => void;
  slots: WorkingSlot[];
  startsOn: string;
  endsOn: string;
  entries: CalendarEntry[];
  timeZone: string;
  periodStatus: OpenDayPeriodStatus;
  dirty: boolean;
  canUndo: boolean;
  lifecyclePending: boolean;
  savePending: boolean;
  onUndo: () => void;
  onSave: () => void;
  onCreate: () => void;
  onPreview: () => void;
  onAdd: (date: string) => void;
  onEdit: (slot: WorkingSlot) => void;
  onRemove: (slots: WorkingSlot[]) => void;
  onBulkEdit: (slots: WorkingSlot[]) => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | undefined>();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const orderedSlots = [...slots].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const visibleSlots = filterOpenDaysByDateTime(orderedSlots, dateTimeFilter, timeZone);
  const slotsById = new Map(visibleSlots.map((slot) => [slot.id, slot]));
  const rows = visibleSlots.map((slot) => ({
    id: slot.id,
    date: dateInTimeZone(slot.startsAt, timeZone),
    time: timeInTimeZone(slot.startsAt, timeZone),
    supervisors: workingRequirementCount(slot, 'supervisor'),
    trainees: workingRequirementCount(slot, 'trainee'),
    note: slot.internalNote || '—',
    actions: '',
    disabled: slot.original?.status === 'cancelled',
  }));
  const headers = [
    { key: 'date', header: 'Date' },
    { key: 'time', header: 'Time' },
    { key: 'supervisors', header: 'Supervisors' },
    { key: 'trainees', header: 'Trainees' },
    { key: 'note', header: 'Internal note' },
    { key: 'actions', header: 'Actions' },
  ];
  const agendaItems: AgendaItem[] = visibleSlots.map((slot) => ({
    id: slot.id,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    status: slot.original?.status,
    disabled: slot.original?.status === 'cancelled',
    summary: timeRange(slot, timeZone),
    details: (
      <>
        <span>{workingRequirementCount(slot, 'supervisor')} supervisors</span>
        <span>{workingRequirementCount(slot, 'trainee')} trainees</span>
        {slot.internalNote && <span>{slot.internalNote}</span>}
      </>
    ),
  }));

  return (
    <DataTable
      key={view === 'list' ? orderedSlots.map((slot) => slot.id).join('|') : 'calendar'}
      rows={rows}
      headers={headers}
      isSortable
    >
      {({
        rows: tableRows,
        headers: tableHeaders,
        selectedRows,
        getBatchActionProps,
        getHeaderProps,
        getRowProps,
        getSelectionProps,
        getTableProps,
      }) => {
        const selectedSlots = (
          isPhone
            ? visibleSlots.filter((slot) => selectedIds.has(slot.id)).map((slot) => ({ id: slot.id }))
            : selectedRows
        )
          .map((row) => slotsById.get(row.id))
          .filter((slot): slot is WorkingSlot => Boolean(slot));
        return (
          <TableContainer className="schedule-editor-view-container">
            <div className="open-days-view-toolbar">
              <TableToolbar aria-label="Schedule editor tools">
                {view === 'list' && !isPhone && selectedSlots.length > 0 && (
                  <TableBatchActions {...getBatchActionProps()}>
                    <TableBatchAction
                      renderIcon={Edit}
                      iconDescription="Edit selected Open Days"
                      onClick={() => onBulkEdit(selectedSlots)}
                    >
                      Edit selected
                    </TableBatchAction>
                    <TableBatchAction
                      renderIcon={periodStatus === 'draft' ? TrashCan : Misuse}
                      iconDescription={removalButtonLabel(selectedSlots, periodStatus)}
                      onClick={() => onRemove(selectedSlots)}
                    >
                      {removalButtonLabel(selectedSlots, periodStatus)}
                    </TableBatchAction>
                  </TableBatchActions>
                )}
                <TableToolbarContent>
                  <div className="schedule-editor-toolbar__actions">
                    <Button
                      hasIconOnly
                      kind="ghost"
                      size="md"
                      renderIcon={Filter}
                      iconDescription="Filter"
                      aria-expanded={filtersOpen}
                      aria-controls="schedule-editor-filters"
                      onClick={() => setFiltersOpen((open) => !open)}
                    />
                    <Button
                      hasIconOnly
                      kind="secondary"
                      size="md"
                      renderIcon={Undo}
                      iconDescription="Undo"
                      disabled={!canUndo}
                      onClick={onUndo}
                    />
                    <Button
                      hasIconOnly
                      kind="secondary"
                      size="md"
                      renderIcon={Save}
                      iconDescription={savePending ? 'Saving…' : 'Save'}
                      disabled={!dirty || savePending || lifecyclePending}
                      onClick={onSave}
                    />
                    <Button renderIcon={Add} onClick={onCreate}>
                      Create
                    </Button>
                    <Button
                      hasIconOnly
                      kind="secondary"
                      size="md"
                      renderIcon={View}
                      iconDescription="Preview"
                      onClick={onPreview}
                    />
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
            {isPhone && view === 'list' && selectedSlots.length > 0 && (
              <div className="open-day-agenda__batch" role="group" aria-label="Selected Open Days">
                <span>{selectedSlots.length} selected</span>
                <Button kind="secondary" renderIcon={Edit} onClick={() => onBulkEdit(selectedSlots)}>
                  Edit selected
                </Button>
                <Button kind="danger--tertiary" onClick={() => onRemove(selectedSlots)}>
                  {removalButtonLabel(selectedSlots, periodStatus)}
                </Button>
                <Button kind="ghost" onClick={() => setSelectedIds(new Set())}>
                  Clear selection
                </Button>
              </div>
            )}
            {filtersOpen && (
              <div id="schedule-editor-filters" className="open-days-filter-panel">
                <OpenDayDateTimeFilters
                  idPrefix="schedule-editor"
                  items={slots}
                  timeZone={timeZone}
                  value={dateTimeFilter}
                  onChange={onDateTimeFilter}
                />
              </div>
            )}
            {view === 'calendar' ? (
              <div className="open-days-view-content open-days-view-content--calendar">
                <CalendarLegend />
                <SemesterCalendarGrid
                  startsOn={startsOn}
                  endsOn={endsOn}
                  entries={entries}
                  className={`semester-calendar--editor${isPhone ? ' semester-calendar--compact' : ''}`}
                  ariaLabel="Schedule planning calendar"
                  renderDay={(day) =>
                    isPhone ? (
                      <CalendarDayCell
                        key={day.date}
                        day={day}
                        className="calendar-cell--compact"
                        selected={selectedDate === day.date}
                        onSelectDate={day.withinRange ? () => setSelectedDate(day.date) : undefined}
                        selectLabel={`Show Open Days on ${formatDate(day.date)}`}
                      >
                        <span className="calendar-cell__event-count" aria-hidden="true">
                          {visibleSlots.filter((slot) => dateInTimeZone(slot.startsAt, timeZone) === day.date).length ||
                            ''}
                        </span>
                      </CalendarDayCell>
                    ) : (
                      <DropDate
                        key={day.date}
                        day={day}
                        slots={visibleSlots.filter((slot) => dateInTimeZone(slot.startsAt, timeZone) === day.date)}
                        timeZone={timeZone}
                        periodStatus={periodStatus}
                        disableDrag={disableDrag}
                        onAdd={() => onAdd(day.date)}
                        onEdit={onEdit}
                        onRemove={(slot) => onRemove([slot])}
                      />
                    )
                  }
                />
                {isPhone && selectedDate && (
                  <div className="open-day-agenda-selection">
                    <SelectedCalendarContext date={selectedDate} entries={entries} />
                    <Button renderIcon={Add} onClick={() => onAdd(selectedDate)}>
                      Add Open Day
                    </Button>
                    <OpenDayAgenda
                      items={agendaItems.filter((item) => dateInTimeZone(item.startsAt, timeZone) === selectedDate)}
                      timeZone={timeZone}
                      emptyMessage="No Open Days on this date."
                      periodStatus={periodStatus}
                      onEdit={(id) => {
                        const slot = slotsById.get(id);
                        if (slot) onEdit(slot);
                      }}
                      onRemove={(id) => {
                        const slot = slotsById.get(id);
                        if (slot) onRemove([slot]);
                      }}
                    />
                  </div>
                )}
              </div>
            ) : isPhone ? (
              <OpenDayAgenda
                selectedIds={selectedIds}
                onSelect={(id, selected) =>
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (selected) next.add(id);
                    else next.delete(id);
                    return next;
                  })
                }
                items={agendaItems}
                timeZone={timeZone}
                emptyMessage="No Open Days match these filters."
                periodStatus={periodStatus}
                onEdit={(id) => {
                  const slot = slotsById.get(id);
                  if (slot) onEdit(slot);
                }}
                onRemove={(id) => {
                  const slot = slotsById.get(id);
                  if (slot) onRemove([slot]);
                }}
              />
            ) : (
              <div className="responsive-table open-days-view-content schedule-editor-table">
                <Table {...getTableProps()} aria-label="Editable Open Days">
                  <TableHead>
                    <TableRow>
                      <TableSelectAll {...getSelectionProps()} />
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
                      const slot = slotsById.get(row.id);
                      return (
                        <TableRow {...getRowProps({ row })} key={row.id}>
                          <TableSelectRow {...getSelectionProps({ row })} />
                          {row.cells.map((cell) => (
                            <TableCell key={cell.id}>
                              {cell.info.header === 'actions' ? (
                                !slot || slot.original?.status === 'cancelled' ? (
                                  '—'
                                ) : (
                                  <div className="table-actions">
                                    <Button
                                      hasIconOnly
                                      kind="ghost"
                                      size="sm"
                                      renderIcon={Edit}
                                      iconDescription={`Edit Open Day on ${dateInTimeZone(slot.startsAt, timeZone)}`}
                                      onClick={() => onEdit(slot)}
                                    />
                                    <Button
                                      hasIconOnly
                                      kind="danger--ghost"
                                      size="sm"
                                      renderIcon={periodStatus === 'draft' || !slot.serverId ? TrashCan : Misuse}
                                      iconDescription={removalButtonLabel([slot], periodStatus)}
                                      onClick={() => onRemove([slot])}
                                    />
                                  </div>
                                )
                              ) : cell.info.header === 'date' && slot ? (
                                longDate(slot.startsAt, timeZone)
                              ) : cell.info.header === 'time' && slot ? (
                                timeRange(slot, timeZone)
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
        );
      }}
    </DataTable>
  );
}
