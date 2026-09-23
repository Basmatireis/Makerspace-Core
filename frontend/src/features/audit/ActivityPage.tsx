import {
  Button,
  DataTable,
  Search,
  Select,
  SelectItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tile,
} from '@carbon/react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { AuditActorType } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { actionLabels, presentAction, presentActor, presentTarget, resourceLabels } from './presentation';
import { activityQuery, type ActivityFilters } from './queries';

const headers = [
  { key: 'time', header: 'Time' },
  { key: 'actor', header: 'Actor' },
  { key: 'action', header: 'Action' },
  { key: 'target', header: 'Target' },
];

export function ActivityPage() {
  const [params, setParams] = useSearchParams();
  const filters: ActivityFilters = {
    action: params.get('action') || undefined,
    actorType: (params.get('actorType') || undefined) as AuditActorType | undefined,
    actorSearch: params.get('actorSearch') || undefined,
    resourceType: params.get('resourceType') || undefined,
  };
  const query = useInfiniteQuery(activityQuery(filters));
  const updateFilter = (key: keyof ActivityFilters, value: string) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: true });
  };
  const events = query.data?.pages.flatMap((page) => page.items) ?? [];
  const rows = events.map((event) => ({
    id: event.id,
    time: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(event.occurredAt)),
    actor: presentActor(event),
    action: presentAction(event),
    target: presentTarget(event),
  }));

  return (
    <Stack gap={7} className="activity-page table-page">
      <PageHeader
        title="Activity log"
        breadcrumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Activity log' }]}
        description="Review privacy-minimized administrative and account activity. Names reflect current records and disappear after deletion."
      />
      <div className="activity-filters">
        <Search
          id="activity-actor-search"
          labelText="Search current actor name"
          placeholder="Search actor name"
          value={filters.actorSearch ?? ''}
          onChange={(event) => updateFilter('actorSearch', event.currentTarget.value)}
        />
        <Select id="activity-actor-type" labelText="Actor type" hideLabel value={filters.actorType ?? ''} onChange={(event) => updateFilter('actorType', event.target.value)}>
          <SelectItem value="" text="All actor types" />
          <SelectItem value="user" text="Users" />
          <SelectItem value="system" text="System" />
          <SelectItem value="unknown" text="Unavailable actors" />
        </Select>
        <Select id="activity-action" labelText="Action" hideLabel value={filters.action ?? ''} onChange={(event) => updateFilter('action', event.target.value)}>
          <SelectItem value="" text="All actions" />
          {Object.entries(actionLabels).sort((left, right) => left[1].localeCompare(right[1])).map(([value, text]) => <SelectItem key={value} value={value} text={text} />)}
        </Select>
        <Select id="activity-resource-type" labelText="Target type" hideLabel value={filters.resourceType ?? ''} onChange={(event) => updateFilter('resourceType', event.target.value)}>
          <SelectItem value="" text="All target types" />
          {Object.entries(resourceLabels).sort((left, right) => left[1].localeCompare(right[1])).map(([value, text]) => <SelectItem key={value} value={value} text={text} />)}
        </Select>
      </div>
      {query.isPending && <InlineLoadingState label="Loading activity" />}
      {query.isError && <ErrorState title="Unable to load activity" message="Check the connection and try again." onRetry={() => void query.refetch()} />}
      {query.data && events.length === 0 && <Tile className="activity-empty"><h2>No activity found</h2><p>Try changing the current filters.</p></Tile>}
      {query.data && events.length > 0 && (
        <Stack gap={4}>
          <DataTable rows={rows} headers={headers}>
            {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
              <TableContainer>
                <Table {...getTableProps()} tabIndex={0} aria-label="Activity log">
                  <TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead>
                  <TableBody>{tableRows.map((row) => <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell) => <TableCell key={cell.id}>{String(cell.value)}</TableCell>)}</TableRow>)}</TableBody>
                </Table>
              </TableContainer>
            )}
          </DataTable>
          {query.hasNextPage && <Button kind="tertiary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading more…' : 'Load more activity'}</Button>}
        </Stack>
      )}
    </Stack>
  );
}
