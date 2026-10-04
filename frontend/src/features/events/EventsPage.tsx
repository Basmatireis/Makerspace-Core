import { Add, Filter } from '@carbon/icons-react';
import {
  Button, DataTable, Dropdown, Link as CarbonLink, OverflowMenu, OverflowMenuItem, Pagination, Tag,
  Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow,
  TableToolbar, TableToolbarContent, TableToolbarSearch,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getGetEventBannerUrl } from '../../api/generated/events/events';
import type { EventStatus } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { eventDateLines, statusTagType } from './format';
import { eventsQueryOptions } from './queries';

const PAGE_SIZES = [10, 25, 50, 100];
const headers = [
  { key: 'name', header: 'Name' },
  { key: 'dateTime', header: 'Date and time' },
  { key: 'location', header: 'Location' },
  { key: 'status', header: 'Status' },
  { key: 'owner', header: 'Owner' },
  { key: 'staffing', header: 'Staffing' },
  { key: 'actions', header: 'Actions' },
];
const statusOptions: Array<{ value: 'all' | EventStatus; label: string }> = [
  { value: 'all', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'planning', label: 'Planning' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'archived', label: 'Archived' },
];

export function EventsPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const query = useQuery(eventsQueryOptions());
  const canManage = hasPermission(currentUser, PermissionId.eventsmanage);
  const [search, setSearch] = useState('');
  const [selectedStatus, setSelectedStatus] = useState(statusOptions[0]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const filteredEvents = useMemo(() => {
    const normalizedSearch = search.trim().toLocaleLowerCase();
    return (query.data?.items ?? []).filter((event) => {
      if (selectedStatus.value !== 'all' && event.status !== selectedStatus.value) return false;
      if (!normalizedSearch) return true;
      return [event.name, event.location, event.ownerName, event.publicTitle]
        .some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
    });
  }, [query.data, search, selectedStatus]);
  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleEvents = filteredEvents.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const eventsById = new Map(visibleEvents.map((event) => [event.id, event]));
  const rows = visibleEvents.map((event) => ({
    id: event.id,
    name: event.name,
    dateTime: event.rangeStartsAt ?? '',
    location: event.location ?? '',
    status: event.status,
    owner: event.ownerName ?? '',
    staffing: `${event.filledCount} / ${event.requiredCount}`,
    actions: '',
  }));
  const hasActiveFilters = selectedStatus.value !== 'all';

  return <PageShell
    title="Events"
    description="Plan and manage workshops, fairs, exhibitions, and community events."
    width="wide"
    className="events-page"
  >
    {query.isPending && <InlineLoadingState label="Loading events" />}
    {query.isError && <ErrorState title="Unable to load events" message="Check the connection and try again." onRetry={() => void query.refetch()} />}
    {query.data && <DataTable rows={rows} headers={headers} isSortable>
      {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => <TableContainer className="events-table-container">
        <TableToolbar aria-label="Events table toolbar">
          <TableToolbarContent>
            <TableToolbarSearch
              id="events-search"
              labelText="Search events"
              placeholder="Search events"
              value={search}
              onChange={(_event, value) => { setSearch(value ?? ''); setPage(1); }}
              onClear={() => { setSearch(''); setPage(1); }}
            />
            <Button
              hasIconOnly
              kind={hasActiveFilters ? 'primary' : 'ghost'}
              size="md"
              renderIcon={Filter}
              iconDescription="Filters"
              aria-expanded={filtersOpen}
              aria-controls="event-filters"
              onClick={() => setFiltersOpen((open) => !open)}
            />
            {canManage && <Button renderIcon={Add} onClick={() => navigate('/events/new')}>Create event</Button>}
          </TableToolbarContent>
        </TableToolbar>
        {filtersOpen && <div id="event-filters" className="event-filter-panel" role="region" aria-label="Event filters"><Dropdown
          id="event-status-filter"
          titleText="Status"
          label="All statuses"
          items={statusOptions}
          itemToString={(item) => item?.label ?? ''}
          selectedItem={selectedStatus}
          onChange={({ selectedItem }) => { setSelectedStatus(selectedItem ?? statusOptions[0]); setPage(1); }}
        /><Button kind="ghost" size="md" disabled={!hasActiveFilters} onClick={() => { setSelectedStatus(statusOptions[0]); setPage(1); }}>Clear filters</Button></div>}
        <Table {...getTableProps()}>
          <TableHead><TableRow>{tableHeaders.map((header) => <TableHeader
            {...getHeaderProps({ header, isSortable: header.key !== 'actions' })}
            key={header.key}
            className={header.key === 'actions' ? 'events-table__actions-column' : undefined}
          >{header.header}</TableHeader>)}</TableRow></TableHead>
          <TableBody>{tableRows.map((row) => {
            const event = eventsById.get(row.id);
            if (!event) return null;
            const date = eventDateLines(event);
            return <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell) => <TableCell key={cell.id} className={cell.info.header === 'actions' ? 'events-table__actions-column' : undefined}>
              {cell.info.header === 'name' ? <div className="events-table__name">{event.hasBanner && <img src={`${getGetEventBannerUrl(event.id)}?v=${encodeURIComponent(event.updatedAt)}`} alt="" loading="lazy"/>}<CarbonLink href={`/events/${event.id}`} onClick={(clickEvent) => { clickEvent.preventDefault(); navigate(`/events/${event.id}`); }}>{event.name}</CarbonLink></div>
                : cell.info.header === 'dateTime' ? <span className="events-table__date"><span>{date.date}</span>{date.time && <span>{date.time}</span>}</span>
                  : cell.info.header === 'location' ? event.location ?? 'Not set'
                    : cell.info.header === 'status' ? <Tag size="sm" type={statusTagType(event.status)}>{event.status}</Tag>
                      : cell.info.header === 'owner' ? event.ownerName ?? 'Not assigned'
                        : cell.info.header === 'staffing' ? `${event.filledCount} / ${event.requiredCount}`
                          : <OverflowMenu iconDescription={`Actions for ${event.name}`} size="sm" flipped><OverflowMenuItem itemText="Open event" onClick={() => navigate(`/events/${event.id}`)}/></OverflowMenu>}
            </TableCell>)}</TableRow>;
          })}</TableBody>
        </Table>
        {filteredEvents.length === 0 && <div className="empty-state"><h2>No events found</h2><p>{search || hasActiveFilters ? 'Try different search terms or filters.' : 'No events have been created yet.'}</p></div>}
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          totalItems={filteredEvents.length}
          onChange={({ page: nextPage, pageSize: nextPageSize }) => { setPage(nextPage); setPageSize(nextPageSize); }}
        />
      </TableContainer>}
    </DataTable>}
  </PageShell>;
}
