import { Button, ContentSwitcher, Switch, TableToolbar, TableToolbarContent, TableToolbarSearch } from '@carbon/react';
import { Add, Checkmark } from '@carbon/icons-react';
import type { FilterDef, FilterValues } from '../model/filters';
import { TableFilters } from '../../../app/components/TableFilters';

export type ScheduleView = 'list' | 'calendar';

/** The toolbar over the list and calendar: search, Filters, the list/calendar switch and the Leitung's tools. */
export function ScheduleToolbar({
  view,
  onView,
  search,
  onSearch,
  filterDefs,
  filters,
  onFilters,
  canManage,
  selecting,
  onSelecting,
  selectedCount,
  onEditSelected,
  onAdd,
}: {
  view: ScheduleView;
  onView: (view: ScheduleView) => void;
  search: string;
  onSearch: (value: string) => void;
  filterDefs: FilterDef[];
  filters: FilterValues;
  onFilters: (values: FilterValues) => void;
  canManage: boolean;
  selecting: boolean;
  onSelecting: () => void;
  selectedCount: number;
  /** Opens the bulk panel as a sheet where the panel does not dock. */
  onEditSelected: (() => void) | null;
  onAdd: () => void;
}) {
  return (
    <TableToolbar aria-label="Schedule toolbar" className="od-toolbar">
      <TableToolbarContent>
        <TableToolbarSearch
          persistent
          id="od-search"
          labelText="Search open days"
          placeholder="Search by date, person or training"
          defaultValue={search}
          onChange={(_event: unknown, value?: string) => onSearch(value ?? '')}
        />
        <TableFilters defs={filterDefs} values={filters} onChange={onFilters} />
        <ContentSwitcher
          size="lg"
          className="od-switch"
          selectedIndex={view === 'list' ? 0 : 1}
          onChange={({ name }) => onView(name === 'calendar' ? 'calendar' : 'list')}
        >
          <Switch name="list" text="List" />
          <Switch name="calendar" text="Calendar" />
        </ContentSwitcher>
        {canManage && (
          <Button
            kind="ghost"
            size="lg"
            renderIcon={Checkmark}
            aria-pressed={selecting}
            className={selecting ? 'is-on' : undefined}
            onClick={onSelecting}
          >
            {selecting ? 'Done' : 'Select'}
          </Button>
        )}
        {canManage && selecting && onEditSelected && (
          <Button kind="tertiary" size="lg" onClick={onEditSelected}>
            Edit {selectedCount}
          </Button>
        )}
        {canManage && (
          <Button kind="primary" size="lg" renderIcon={Add} onClick={onAdd} data-guide="open-days-add">
            Add open days
          </Button>
        )}
      </TableToolbarContent>
    </TableToolbar>
  );
}
