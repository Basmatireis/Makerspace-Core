import './styles.scss';
import { Add, Edit, TrashCan, UserMultiple } from '@carbon/icons-react';
import {
  Button,
  DataTable,
  Link as CarbonLink,
  Pagination,
  Tag,
  Tile,
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
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { deleteEvent, getGetEventBannerUrl } from '../../api/generated/events/events';
import type { Event, EventStatus } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { BatchFilter } from '../../app/BatchFilter';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, InlineLoadingState } from '../../app/PageState';
import { RowActions } from '../../app/RowActions';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { EventCreateDialog } from './EventCreateDialog';
import { eventMutationMessage } from './errors';
import { eventDateLines, statusTagType } from './format';
import { eventKeys, eventsQueryOptions } from './queries';

const PAGE_SIZES = [10, 25, 50, 100];
const headers = [
  { key: 'name', header: 'Name' },
  { key: 'status', header: 'Status' },
  { key: 'location', header: 'Location' },
  { key: 'staffing', header: 'Staffing' },
  { key: 'owner', header: 'Owner' },
  { key: 'actions', header: 'Actions' },
];
const statusOptions: Array<{ id: EventStatus; label: string }> = [
  { id: 'draft', label: 'Draft' },
  { id: 'confirmed', label: 'Confirmed' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
];

export type EventListState = {
  search: string;
  statuses: EventStatus[];
  page: number;
  pageSize: number;
  scrollY: number;
};

type EventsPageProps = {
  initialState?: EventListState;
  createOpen?: boolean;
  onCloseCreate?: () => void;
};

function deleteError(error: unknown) {
  if (error instanceof ApiError && error.status === 409 && error.data?.code === 'event_has_assignment_history') {
    return 'This draft has assignment history and cannot be deleted. Keep it as a retained event record.';
  }
  return eventMutationMessage(error);
}

export function EventsPage({ initialState, createOpen = false, onCloseCreate }: EventsPageProps = {}) {
  const currentUser = useCurrentUser();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery(eventsQueryOptions());
  const canManage = hasPermission(currentUser, PermissionId.eventsmanage);
  const canStaff =
    hasPermission(currentUser, PermissionId.eventsstaffingmanage) ||
    hasPermission(currentUser, PermissionId.eventsassign);
  const restoredState = initialState ?? (location.state as { eventList?: EventListState } | null)?.eventList;
  const [search, setSearch] = useState(restoredState?.search ?? '');
  const [selectedStatuses, setSelectedStatuses] = useState<EventStatus[]>(restoredState?.statuses ?? []);
  const [page, setPage] = useState(restoredState?.page ?? 1);
  const [pageSize, setPageSize] = useState(restoredState?.pageSize ?? 25);
  const [deleteTarget, setDeleteTarget] = useState<Event | null>(null);
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const remove = useMutation({
    mutationFn: (event: Event) => deleteEvent(event.id, { expectedVersion: event.version }),
    onSuccess: async () => {
      setDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: eventKeys.all });
    },
  });

  useEffect(() => {
    if (!createOpen && restoredState) {
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: restoredState.scrollY });
        createButtonRef.current?.focus();
      });
    }
  }, [createOpen, restoredState]);

  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredEvents = (query.data?.items ?? []).filter((event) => {
    if (selectedStatuses.length > 0 && !selectedStatuses.includes(event.status)) return false;
    if (!normalizedSearch) return true;
    return [event.name, event.location, event.ownerName, event.publicTitle].some((value) =>
      value?.toLocaleLowerCase().includes(normalizedSearch),
    );
  });
  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * pageSize;
  const visibleEvents = filteredEvents.slice(pageStart, pageStart + pageSize);
  const eventsById = new Map(filteredEvents.map((event) => [event.id, event]));
  // DataTable sorts every filtered row; pagination slices the sorted result.
  const rows = filteredEvents.map((event) => ({
    id: event.id,
    name: event.name,
    status: event.status,
    location: event.location ?? '',
    staffing: `${event.filledCount} / ${event.requiredCount}`,
    owner: event.ownerName ?? '',
    actions: '',
  }));
  const hasActiveFilters = selectedStatuses.length > 0;
  const listState = (): EventListState => ({
    search,
    statuses: selectedStatuses,
    page: currentPage,
    pageSize,
    scrollY: window.scrollY,
  });
  const openCreate = () => {
    const state = { eventList: listState() };
    navigate('/events', { replace: true, state, flushSync: true });
    navigate('/events/new', { state });
  };
  const openEvent = (event: Event, tab?: 'settings' | 'staffing') =>
    navigate(`/events/${event.id}${tab ? `?tab=${tab}` : ''}`);
  const actions = (event: Event) => (
    <RowActions label={`Actions for ${event.name}`} className="events-row-actions">
      {canManage && (
        <Button
          kind="ghost"
          size="sm"
          renderIcon={Edit}
          disabled={['completed', 'cancelled', 'archived'].includes(event.status)}
          title={
            ['completed', 'cancelled', 'archived'].includes(event.status)
              ? 'Event details are read-only after the event ends.'
              : undefined
          }
          onClick={() => openEvent(event, 'settings')}
        >
          Edit
        </Button>
      )}
      {canStaff && (
        <Button
          kind="ghost"
          size="sm"
          renderIcon={UserMultiple}
          disabled={['completed', 'cancelled', 'archived'].includes(event.status)}
          title={
            ['completed', 'cancelled', 'archived'].includes(event.status)
              ? 'Staffing is read-only after the event ends.'
              : undefined
          }
          onClick={() => openEvent(event, 'staffing')}
        >
          Staffing
        </Button>
      )}
      {canManage && event.status === 'draft' && (
        <Button
          kind="danger--ghost"
          size="sm"
          renderIcon={TrashCan}
          onClick={() => {
            remove.reset();
            setDeleteTarget(event);
          }}
        >
          Delete
        </Button>
      )}
    </RowActions>
  );

  return (
    <PageShell
      title="Events"
      description="Plan and manage workshops, fairs, exhibitions, and community events."
      width="wide"
      className="events-page"
    >
      {query.isPending && <InlineLoadingState label="Loading events" />}
      {query.isError && (
        <ErrorState
          title="Unable to load events"
          message="Check the connection and try again."
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && (
        <DataTable rows={rows} headers={headers} isSortable>
          {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
            <TableContainer className="events-table-container">
              <TableToolbar aria-label="Events table toolbar">
                <TableToolbarContent>
                  <TableToolbarSearch
                    id="events-search"
                    labelText="Search events"
                    placeholder="Search events"
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
                    id="events"
                    label="Events"
                    categories={[{ key: 'status', label: 'Status', options: statusOptions }]}
                    applied={{ status: selectedStatuses }}
                    onApply={(values) => {
                      setSelectedStatuses((values.status ?? []) as EventStatus[]);
                      setPage(1);
                    }}
                    onReset={() => {
                      setSelectedStatuses([]);
                      setPage(1);
                    }}
                  />
                  {canManage && (
                    <Button ref={createButtonRef} renderIcon={Add} onClick={openCreate}>
                      Create event
                    </Button>
                  )}
                </TableToolbarContent>
              </TableToolbar>
              <div className="events-desktop-list">
                <Table {...getTableProps()}>
                  <TableHead>
                    <TableRow>
                      {tableHeaders.map((header) => (
                        <TableHeader
                          {...getHeaderProps({ header, isSortable: header.key !== 'actions' })}
                          key={header.key}
                          className={header.key === 'actions' ? 'events-table__actions-column' : undefined}
                        >
                          {header.header}
                        </TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {tableRows.slice(pageStart, pageStart + pageSize).map((row) => {
                      const event = eventsById.get(row.id);
                      if (!event) return null;
                      const date = eventDateLines(event);
                      return (
                        <TableRow {...getRowProps({ row })} key={row.id}>
                          {row.cells.map((cell) => (
                            <TableCell
                              key={cell.id}
                              className={cell.info.header === 'actions' ? 'events-table__actions-column' : undefined}
                            >
                              {cell.info.header === 'name' ? (
                                <div className="events-table__name">
                                  {event.hasBanner && (
                                    <img
                                      src={`${getGetEventBannerUrl(event.id)}?v=${encodeURIComponent(event.updatedAt)}`}
                                      alt=""
                                      loading="lazy"
                                    />
                                  )}
                                  <span>
                                    <CarbonLink as={Link} to={`/events/${event.id}`}>
                                      {event.name}
                                    </CarbonLink>
                                    <span className="events-table__date">
                                      <span>{date.date}</span>
                                      {date.time && <span>{date.time}</span>}
                                    </span>
                                  </span>
                                </div>
                              ) : cell.info.header === 'status' ? (
                                <Tag size="sm" type={statusTagType(event.status)}>
                                  {event.status}
                                </Tag>
                              ) : cell.info.header === 'location' ? (
                                (event.location ?? 'Not set')
                              ) : cell.info.header === 'staffing' ? (
                                `${event.filledCount} / ${event.requiredCount}`
                              ) : cell.info.header === 'owner' ? (
                                (event.ownerName ?? 'Not assigned')
                              ) : (
                                actions(event)
                              )}
                            </TableCell>
                          ))}
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="events-mobile-list" aria-label="Events">
                {visibleEvents.map((event) => {
                  const date = eventDateLines(event);
                  return (
                    <Tile key={event.id} className="event-mobile-card">
                      <div className="event-mobile-card__heading">
                        <div>
                          <CarbonLink as={Link} to={`/events/${event.id}`}>
                            {event.name}
                          </CarbonLink>
                          <p>
                            {date.date}
                            {date.time ? ` · ${date.time}` : ''}
                          </p>
                        </div>
                        <Tag size="sm" type={statusTagType(event.status)}>
                          {event.status}
                        </Tag>
                      </div>
                      <dl>
                        <div>
                          <dt>Location</dt>
                          <dd>{event.location ?? 'Not set'}</dd>
                        </div>
                        <div>
                          <dt>Staffing</dt>
                          <dd>
                            {event.filledCount} of {event.requiredCount}
                          </dd>
                        </div>
                        <div>
                          <dt>Owner</dt>
                          <dd>{event.ownerName ?? 'Not assigned'}</dd>
                        </div>
                      </dl>
                      {actions(event)}
                    </Tile>
                  );
                })}
              </div>
              {filteredEvents.length === 0 && (
                <EmptyState
                  title="No events found"
                  description={
                    search || hasActiveFilters
                      ? 'Try different search terms or filters.'
                      : 'No events have been created yet.'
                  }
                />
              )}
              <Pagination
                page={currentPage}
                pageSize={pageSize}
                pageSizes={PAGE_SIZES}
                totalItems={filteredEvents.length}
                onChange={({ page: nextPage, pageSize: nextPageSize }) => {
                  setPage(nextPage);
                  setPageSize(nextPageSize);
                }}
              />
            </TableContainer>
          )}
        </DataTable>
      )}
      <EventCreateDialog open={createOpen} onClose={onCloseCreate ?? (() => navigate('/events', { replace: true }))} />
      <DestructiveActionDialog
        open={Boolean(deleteTarget)}
        title={`Delete ${deleteTarget?.name ?? 'event'}?`}
        confirmLabel="Delete event"
        pending={remove.isPending}
        error={remove.isError ? deleteError(remove.error) : undefined}
        onClose={() => {
          if (!remove.isPending) setDeleteTarget(null);
        }}
        onConfirm={() => {
          if (deleteTarget) remove.mutate(deleteTarget);
        }}
      >
        <p>
          This permanently deletes the draft event and its planning data. Draft events with any current or historical
          staffing assignment cannot be deleted.
        </p>
      </DestructiveActionDialog>
    </PageShell>
  );
}
