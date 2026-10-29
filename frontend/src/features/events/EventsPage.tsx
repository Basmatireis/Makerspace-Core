import './styles.scss';
import { Add } from '@carbon/icons-react';
import {
  Button,
  Link as CarbonLink,
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
  Tile,
} from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Event, EventListScope } from '../../api/generated/models';
import { BatchFilter, type FilterValues } from '../../app/BatchFilter';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, InlineLoadingState } from '../../app/PageState';
import { SectionSwitcher } from '../../app/SectionSwitcher';
import { useCurrentUser } from '../auth/auth';
import { eventAccess } from './access';
import { ScrollRegion } from './components/ScrollRegion';
import { FillMeter } from './components/FillMeter';
import { PersonCombo } from './components/PersonCombo';
import { EventStatusTag, PublicPageTag, SignupStateTag } from './components/StatusTags';
import { CreateEventDialog } from './CreateEventDialog';
import { rangeLabel } from './format';
import { eventListQueryOptions } from './queries';
import { useDebouncedValue } from './useDebouncedValue';

const PAGE_SIZES = [10, 25, 50];
const SCOPE_LABEL: Record<EventListScope, string> = { upcoming: 'Upcoming', drafts: 'Drafts', past: 'Past' };
const EMPTY_TEXT: Record<EventListScope, string> = {
  upcoming: 'No confirmed events are coming up.',
  drafts: 'No events are being planned.',
  past: 'No completed or cancelled events yet.',
};

function isScope(value: string | null): value is EventListScope {
  return value === 'upcoming' || value === 'drafts' || value === 'past';
}

function OwnerFilter({
  idPrefix,
  staged,
  set,
}: {
  idPrefix: string;
  staged: FilterValues;
  set: (key: string, value: string[]) => void;
}) {
  const id = staged.owner?.[0];
  return (
    <PersonCombo
      id={`${idPrefix}-owner`}
      titleText="Owner"
      value={id ? { id, label: staged.ownerName?.[0] ?? '' } : null}
      onChange={(choice) => {
        set('owner', choice ? [choice.id] : []);
        set('ownerName', choice ? [choice.label] : []);
      }}
    />
  );
}

export function EventsPage({
  createOpen = false,
  onCloseCreate,
}: { createOpen?: boolean; onCloseCreate?: () => void } = {}) {
  const access = eventAccess(useCurrentUser());
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const requested = params.get('scope');
  const scope: EventListScope =
    isScope(requested) && (requested !== 'drafts' || access.organizer) ? requested : 'upcoming';
  const [search, setSearch] = useState('');
  const [owner, setOwner] = useState<FilterValues>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const debouncedSearch = useDebouncedValue(search.trim());
  const query = useQuery({
    ...eventListQueryOptions({
      scope,
      search: debouncedSearch || undefined,
      ownerPersonId: owner.owner?.[0],
      page,
      pageSize,
    }),
    placeholderData: keepPreviousData,
  });
  const events = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const filtering = Boolean(debouncedSearch || owner.owner?.length);
  const sections = (access.organizer ? (['upcoming', 'drafts', 'past'] as const) : (['upcoming', 'past'] as const)).map(
    (id) => ({ id, label: SCOPE_LABEL[id] }),
  );
  const create = access.manage ? (
    <Button renderIcon={Add} onClick={() => navigate('/events/new')}>
      Create event
    </Button>
  ) : undefined;
  const href = (event: Event) => (access.canEdit ? `/events/${event.id}?mode=edit` : `/events/${event.id}`);
  const switchScope = (next: string) => {
    setParams(next === 'upcoming' ? {} : { scope: next }, { replace: true });
    setPage(1);
  };

  const nameCell = (event: Event) => (
    <div className="ev-cell-stack">
      <CarbonLink as={Link} to={href(event)}>
        {event.name}
      </CarbonLink>
      <span className="ev-secondary">{event.location || 'No location'}</span>
    </div>
  );
  const placesCell = (event: Event) =>
    event.requiredCount === 0 ? (
      <span className="ev-secondary">No places</span>
    ) : (
      <span>
        {event.openPlaces} of {event.requiredCount}
      </span>
    );
  const shiftsCell = (event: Event) =>
    event.myShifts.length === 0 ? (
      <span className="ev-secondary">—</span>
    ) : (
      <div className="ev-cell-stack">
        {event.myShifts.map((shift) => (
          <span key={shift.assignmentId}>
            {shift.shiftName} · {shift.requirementName}
          </span>
        ))}
      </div>
    );
  const staffCell = (event: Event) =>
    event.requiredCount === 0 ? (
      <span className="ev-secondary">No places</span>
    ) : (
      <FillMeter filled={event.filledCount} required={event.requiredCount} />
    );
  const taskCell = (event: Event) =>
    event.taskTotal === 0 ? (
      <span className="ev-secondary">—</span>
    ) : (
      <span className={event.tasksOverdue > 0 ? 'ev-overdue' : undefined}>
        {event.taskCompleted}/{event.taskTotal}
        {event.tasksOverdue > 0 && ` · ${event.tasksOverdue} overdue`}
      </span>
    );
  const ownerCell = (event: Event) => event.ownerName ?? <span className="ev-overdue">No owner</span>;

  return (
    <PageShell
      title="Events"
      description="Workshops, fairs and community events with their helpers."
      width="wide"
      className="events-page"
      actions={create}
    >
      <TableContainer>
        <TableToolbar aria-label="Events toolbar" className="ev-list-toolbar">
          <SectionSwitcher label="Event sections" selected={scope} sections={sections} onChange={switchScope} />
          <TableToolbarContent>
            <TableToolbarSearch
              id="events-search"
              labelText="Search events"
              placeholder="Search by name, location or organizer"
              persistent
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
            {access.organizer && (
              <BatchFilter
                id="events"
                label="Events"
                categories={[
                  {
                    key: 'owner',
                    keys: ['owner', 'ownerName'],
                    label: 'Owner',
                    render: (context) => <OwnerFilter {...context} />,
                  },
                ]}
                applied={owner}
                onApply={(values) => {
                  setOwner(values);
                  setPage(1);
                }}
                onReset={() => {
                  setOwner({});
                  setPage(1);
                }}
              />
            )}
          </TableToolbarContent>
        </TableToolbar>
        {query.isPending && <InlineLoadingState label="Loading events" />}
        {query.isError && (
          <ErrorState
            title="Unable to load events"
            message="Check the connection and try again."
            onRetry={() => void query.refetch()}
          />
        )}
        {query.isSuccess && events.length === 0 && (
          <EmptyState
            title="No events found"
            description={
              filtering
                ? 'Try another search or owner.'
                : scope === 'upcoming' && access.manage
                  ? 'Create an event, add its programme and helper shifts, then put the public page live.'
                  : EMPTY_TEXT[scope]
            }
          />
        )}
        {events.length > 0 && (
          <>
            <div className="ev-wide">
              <ScrollRegion label="Events">
                <Table aria-label="Events">
                  <TableHead>
                    {access.organizer ? (
                      <TableRow>
                        <TableHeader>Date</TableHeader>
                        <TableHeader>Name</TableHeader>
                        <TableHeader>Status</TableHeader>
                        <TableHeader>Public page</TableHeader>
                        <TableHeader>Helper signup</TableHeader>
                        <TableHeader>Places filled</TableHeader>
                        <TableHeader>Tasks</TableHeader>
                        <TableHeader>Owner</TableHeader>
                      </TableRow>
                    ) : (
                      <TableRow>
                        <TableHeader>Date</TableHeader>
                        <TableHeader>Event</TableHeader>
                        <TableHeader>Open places</TableHeader>
                        <TableHeader>Your shifts</TableHeader>
                      </TableRow>
                    )}
                  </TableHead>
                  <TableBody>
                    {events.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell>{rangeLabel(event)}</TableCell>
                        <TableCell>{nameCell(event)}</TableCell>
                        {access.organizer ? (
                          <>
                            <TableCell>
                              <EventStatusTag status={event.status} size="sm" />
                            </TableCell>
                            <TableCell>
                              <PublicPageTag event={event} size="sm" />
                            </TableCell>
                            <TableCell>
                              <SignupStateTag event={event} size="sm" />
                            </TableCell>
                            <TableCell>{staffCell(event)}</TableCell>
                            <TableCell>{taskCell(event)}</TableCell>
                            <TableCell>{ownerCell(event)}</TableCell>
                          </>
                        ) : (
                          <>
                            <TableCell>{placesCell(event)}</TableCell>
                            <TableCell>{shiftsCell(event)}</TableCell>
                          </>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollRegion>
            </div>
            <div className="ev-cards" aria-label="Events">
              {events.map((event) => (
                <Tile key={event.id} className="ev-card">
                  <div className="ev-card__head">
                    {nameCell(event)}
                    {access.organizer && <EventStatusTag status={event.status} size="sm" />}
                  </div>
                  <div>{rangeLabel(event)}</div>
                  {access.organizer ? (
                    <dl className="ev-strip ev-strip--card">
                      <div>
                        <dt>Public page</dt>
                        <dd>
                          <PublicPageTag event={event} size="sm" />
                        </dd>
                      </div>
                      <div>
                        <dt>Helper signup</dt>
                        <dd>
                          <SignupStateTag event={event} size="sm" />
                        </dd>
                      </div>
                      <div>
                        <dt>Places filled</dt>
                        <dd>{staffCell(event)}</dd>
                      </div>
                      <div>
                        <dt>Tasks</dt>
                        <dd>{taskCell(event)}</dd>
                      </div>
                      <div>
                        <dt>Owner</dt>
                        <dd>{ownerCell(event)}</dd>
                      </div>
                    </dl>
                  ) : (
                    <dl className="ev-strip ev-strip--card">
                      <div>
                        <dt>Open places</dt>
                        <dd>{placesCell(event)}</dd>
                      </div>
                      <div>
                        <dt>Your shifts</dt>
                        <dd>{shiftsCell(event)}</dd>
                      </div>
                    </dl>
                  )}
                </Tile>
              ))}
            </div>
          </>
        )}
        {total > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            pageSizes={PAGE_SIZES}
            totalItems={total}
            itemsPerPageText="Events per page"
            onChange={({ page: nextPage, pageSize: nextPageSize }) => {
              setPage(nextPageSize === pageSize ? nextPage : 1);
              setPageSize(nextPageSize);
            }}
          />
        )}
      </TableContainer>
      {createOpen && (
        <CreateEventDialog open onClose={onCloseCreate ?? (() => navigate('/events', { replace: true }))} />
      )}
    </PageShell>
  );
}
