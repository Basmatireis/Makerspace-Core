import {
  Button,
  DataTable,
  RadioButton,
  RadioButtonGroup,
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
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  Tile,
} from '@carbon/react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import type { AuditActorType } from '../../api/generated/models';
import { BatchFilter, type FilterCategory } from '../../app/BatchFilter';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { formatDateTime } from '../../app/dateTime';
import { actionLabels, presentAction, presentActor, presentTarget, resourceLabels } from './presentation';
import { activityQuery, type ActivityFilters } from './queries';

const headers = [
  { key: 'time', header: 'Time' },
  { key: 'actor', header: 'Actor' },
  { key: 'action', header: 'Action' },
  { key: 'target', header: 'Target' },
];
const FILTER_KEYS = ['actorType', 'action', 'resourceType'];
const sortedLabels = (labels: Record<string, string>) => Object.entries(labels).sort((left, right) => left[1].localeCompare(right[1]));

/** The action and target lists are long, so they are single-choice selects inside the filter panel instead of check lists. */
const selectCategory = (key: string, label: string, anyLabel: string, labels: Record<string, string>): FilterCategory => ({
  key, label,
  render: ({ idPrefix, staged, set }) => (
    <Select id={`${idPrefix}-select`} labelText={label} hideLabel value={staged[key]?.[0] ?? ''} onChange={(event) => set(key, event.target.value ? [event.target.value] : [])}>
      <SelectItem value="" text={anyLabel} />
      {sortedLabels(labels).map(([value, text]) => <SelectItem key={value} value={value} text={text} />)}
    </Select>
  ),
});

const filterCategories: FilterCategory[] = [
  {
    key: 'actorType', label: 'Actor type',
    render: ({ idPrefix, staged, set }) => (
      <RadioButtonGroup legendText={<span className="cds--visually-hidden">Actor type</span>} name={`${idPrefix}-radio`} orientation="vertical" valueSelected={staged.actorType?.[0] ?? ''} onChange={(value) => set('actorType', value ? [String(value)] : [])}>
        <RadioButton id={`${idPrefix}-any`} value="" labelText="All actor types" />
        <RadioButton id={`${idPrefix}-user`} value="user" labelText="Users" />
        <RadioButton id={`${idPrefix}-system`} value="system" labelText="System" />
        <RadioButton id={`${idPrefix}-unknown`} value="unknown" labelText="Unavailable actors" />
      </RadioButtonGroup>
    ),
  },
  selectCategory('action', 'Action', 'All actions', actionLabels),
  selectCategory('resourceType', 'Target type', 'All target types', resourceLabels),
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
  const updateFilter = (patch: Record<string, string | null>) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
      return next;
    }, { replace: true });
  };
  const applied = Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) ? [params.get(key) as string] : []]));
  const events = query.data?.pages.flatMap((page) => page.items) ?? [];
  const rows = events.map((event) => ({
    id: event.id,
    time: formatDateTime(event.occurredAt),
    actor: presentActor(event),
    action: presentAction(event),
    target: presentTarget(event),
  }));

  return (
    <PageShell
      title="Audit Log"
      description="Review privacy-minimized administrative and account activity. Names reflect current records and disappear after deletion."
      width="wide"
      className="activity-page table-page"
    >
      <TableContainer>
        <TableToolbar aria-label="Audit Log table toolbar">
          <TableToolbarContent>
            <TableToolbarSearch
              id="activity-actor-search" labelText="Search current actor name" placeholder="Search actor name" persistent
              value={filters.actorSearch ?? ''} onChange={(_event, value) => updateFilter({ actorSearch: value ?? '' })} onClear={() => updateFilter({ actorSearch: null })}
            />
            <BatchFilter
              id="activity" label="Audit Log" categories={filterCategories} applied={applied}
              onApply={(values) => updateFilter(Object.fromEntries(FILTER_KEYS.map((key) => [key, values[key]?.[0] ?? null])))}
              onReset={() => updateFilter(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])))}
            />
          </TableToolbarContent>
        </TableToolbar>
        {query.isPending && <InlineLoadingState label="Loading activity" />}
        {query.isError && <ErrorState title="Unable to load activity" message="Check the connection and try again." onRetry={() => void query.refetch()} />}
        {query.data && events.length === 0 && <Tile className="activity-empty"><h2>No activity found</h2><p>Try changing the current filters.</p></Tile>}
        {query.data && events.length > 0 && (
          <Stack gap={4}>
            <DataTable rows={rows} headers={headers}>
              {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
                <Table {...getTableProps()} tabIndex={0} aria-label="Audit Log">
                  <TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead>
                  <TableBody>{tableRows.map((row) => <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell) => <TableCell key={cell.id}>{String(cell.value)}</TableCell>)}</TableRow>)}</TableBody>
                </Table>
              )}
            </DataTable>
            {query.hasNextPage && <Button kind="tertiary" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading more…' : 'Load more activity'}</Button>}
          </Stack>
        )}
      </TableContainer>
    </PageShell>
  );
}
