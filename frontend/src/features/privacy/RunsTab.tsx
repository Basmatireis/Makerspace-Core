import {
  Button,
  ButtonSet,
  Checkbox,
  CheckboxGroup,
  DataTable,
  InlineNotification,
  Link as CarbonLink,
  Pagination,
  Popover,
  PopoverContent,
  SkeletonText,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableExpandedRow,
  TableExpandHeader,
  TableExpandRow,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
  Tag,
} from '@carbon/react';
import { CheckmarkFilled, ErrorFilled, Filter, InProgress, WarningFilled } from '@carbon/icons-react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { PrivacyCategory, RetentionRun, RetentionRunItem } from '../../api/generated/models';
import { startRetentionRun } from '../../api/generated/privacy/privacy';
import { PrivacyLink } from './privacyNavigation';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { RichNotification } from '../../app/RichNotification';
import {
  addCalendarDays,
  APP_LOCALE,
  dateInAppTimeZone,
  formatDate,
  formatDateTime,
  formatLongDate,
  formatTime,
} from '../../app/dateTime';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import {
  categoryName,
  privacyCategoriesQueryOptions,
  privacyErrorMessage,
  privacyOverviewQueryOptions,
  privacyQueryKey,
  retentionRunQueryOptions,
  retentionRunsQueryOptions,
} from './privacy';

const headers = [
  { key: 'started', header: 'Started' },
  { key: 'mode', header: 'Mode' },
  { key: 'by', header: 'Started by' },
  { key: 'result', header: 'Result' },
  { key: 'duration', header: 'Duration' },
];

const modeFilters: { id: RetentionRun['mode']; label: string }[] = [
  { id: 'dry_run', label: 'Dry run' },
  { id: 'execute', label: 'Executed' },
];
const statusFilters: { id: RetentionRun['status']; label: string }[] = [
  { id: 'completed', label: 'Completed' },
  { id: 'failed', label: 'Failed' },
  { id: 'running', label: 'Running' },
];

const actionLabels: Record<RetentionRunItem['action'], string> = {
  delete: 'Delete',
  anonymize: 'Anonymise',
  unlink: 'Unlink the person',
  redact: 'Redact',
  retain_with_review: 'Keep and review',
};

const numberFormat = new Intl.NumberFormat(APP_LOCALE);

function plural(count: number, one: string, many: string): string {
  return `${numberFormat.format(count)} ${count === 1 ? one : many}`;
}

function summarize(items: readonly RetentionRunItem[]) {
  const applied = items.filter((item) => item.status === 'applied');
  return {
    rows: applied.reduce((total, item) => total + item.affectedCount, 0),
    categories: applied.length,
    onHold: items.filter((item) => item.status === 'skipped_hold').length,
    noPolicy: items.filter((item) => item.status === 'skipped_no_handler').length,
    failed: items.filter((item) => item.status === 'failed').length,
  };
}

function skippedText(summary: ReturnType<typeof summarize>): string {
  return [
    summary.onHold > 0 ? `${numberFormat.format(summary.onHold)} skipped: on hold` : '',
    summary.noPolicy > 0 ? `${numberFormat.format(summary.noPolicy)} skipped: no policy` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function resultText(run: RetentionRun, summary: ReturnType<typeof summarize>): string {
  const verb = run.mode === 'dry_run' ? 'Would change' : 'Changed';
  return `${verb} ${plural(summary.rows, 'row', 'rows')} in ${plural(summary.categories, 'category', 'categories')}`;
}

/** "Today, 15:42" / "Yesterday, 03:00" / "19.10.2026, 03:00". */
function startedLine(value: string): string {
  const day = dateInAppTimeZone(value);
  const today = dateInAppTimeZone(new Date());
  const time = formatTime(value);
  if (day === today) return `Today, ${time}`;
  if (day && day === addCalendarDays(today, -1)) return `Yesterday, ${time}`;
  return `${formatDate(value)}, ${time}`;
}

function durationText(run: RetentionRun): string {
  if (!run.finishedAt) return run.status === 'running' ? 'running' : '–';
  const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

function actorText(run: RetentionRun): string {
  return run.trigger === 'manual' ? 'manual run' : 'admin cleanup (scheduler)';
}

function ruleText(category: PrivacyCategory | undefined, item: RetentionRunItem): string {
  const action = actionLabels[item.action];
  const policy = category?.coverage.policy;
  if (!policy) return action;
  return policy.periodDays === 0
    ? `${action}, as soon as ${policy.trigger}`
    : `${action}, ${policy.periodDays} days after ${policy.trigger}`;
}

function StatusIcon({ run }: { run: RetentionRun }) {
  if (run.status === 'failed') return <ErrorFilled size={16} style={{ fill: 'var(--cds-support-error)' }} />;
  if (run.status === 'running') return <InProgress size={16} />;
  return <CheckmarkFilled size={16} style={{ fill: 'var(--cds-support-success)' }} />;
}

function modeTag(run: RetentionRun) {
  if (run.status === 'failed') return <Tag type="red">Failed</Tag>;
  return run.mode === 'dry_run' ? <Tag type="blue">Dry run</Tag> : <Tag type="green">Executed</Tag>;
}

function ItemStatus({ item, dryRun }: { item: RetentionRunItem; dryRun: boolean }) {
  switch (item.status) {
    case 'applied':
      return (
        <Tag type="green" size="sm">
          {dryRun ? 'would run' : 'ran'}
        </Tag>
      );
    case 'skipped_hold':
      return (
        <>
          <Tag type="warm-gray" size="sm">
            skipped: on hold
          </Tag>{' '}
          <PrivacyLink section="holds" size="sm">
            why?
          </PrivacyLink>
        </>
      );
    case 'skipped_no_handler':
      return (
        <Tag type="gray" size="sm">
          skipped: no handler
        </Tag>
      );
    case 'failed':
      return (
        <>
          <Tag type="red" size="sm">
            failed
          </Tag>
          {item.errorCode && <div className="cds--type-helper-text-01">{item.errorCode}</div>}
        </>
      );
  }
}

const COLLAPSE_AFTER = 3;

function ItemsTable({
  items,
  categories,
  mode,
}: {
  items: readonly RetentionRunItem[];
  categories: readonly PrivacyCategory[];
  mode: RetentionRun['mode'];
}) {
  if (items.length === 0) return <p>This run planned no work.</p>;
  const dryRun = mode === 'dry_run';
  const noHandler = items.filter((item) => item.status === 'skipped_no_handler');
  const collapse = noHandler.length > COLLAPSE_AFTER;
  const shown = collapse ? items.filter((item) => item.status !== 'skipped_no_handler') : items;
  return (
    <Table size="sm" aria-label="Run items">
      <TableHead>
        <TableRow>
          <TableHeader>Data category</TableHeader>
          <TableHeader>{dryRun ? 'What would happen' : 'What happened'}</TableHeader>
          <TableHeader style={{ textAlign: 'right' }}>Rows</TableHeader>
          <TableHeader>Status</TableHeader>
        </TableRow>
      </TableHead>
      <TableBody>
        {shown.map((item) => {
          const category = categories.find((candidate) => candidate.id === item.categoryId);
          return (
            <TableRow key={`${item.categoryId}-${item.policyId ?? 'legacy'}-${item.action}`}>
              <TableCell>
                <PrivacyLink section="categories">{categoryName(categories, item.categoryId)}</PrivacyLink>
                {category?.description && <div className="cds--type-helper-text-01">{category.description}</div>}
              </TableCell>
              <TableCell>{ruleText(category, item)}</TableCell>
              <TableCell style={{ textAlign: 'right' }}>
                {item.status === 'applied' || item.status === 'failed' ? item.affectedCount : '–'}
              </TableCell>
              <TableCell>
                <ItemStatus item={item} dryRun={dryRun} />
              </TableCell>
            </TableRow>
          );
        })}
        {collapse && (
          <TableRow>
            <TableCell>{plural(noHandler.length, 'category', 'categories')} without a policy</TableCell>
            <TableCell>Nothing, until a policy is active</TableCell>
            <TableCell style={{ textAlign: 'right' }}>–</TableCell>
            <TableCell>
              <Tag type="gray" size="sm">
                skipped: no handler
              </Tag>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

function RunDetail({
  run,
  items,
  categories,
  canExecute,
  busy,
  onExecute,
}: {
  run: RetentionRun;
  items: readonly RetentionRunItem[];
  categories: readonly PrivacyCategory[];
  canExecute: boolean;
  busy: boolean;
  onExecute: () => void;
}) {
  return (
    <Stack gap={5}>
      <ItemsTable items={items} categories={categories} mode={run.mode} />
      {canExecute && run.mode === 'dry_run' && (
        <ButtonSet style={{ justifyContent: 'flex-end' }}>
          <Button kind="danger" size="md" disabled={busy} onClick={onExecute}>
            Execute this now
          </Button>
        </ButtonSet>
      )}
    </Stack>
  );
}

export function RunsTab() {
  const currentUser = useCurrentUser();
  const canExecute = hasPermission(currentUser, 'privacy.retention.execute');
  const client = useQueryClient();
  const runs = useQuery(retentionRunsQueryOptions());
  const categories = useQuery(privacyCategoriesQueryOptions());
  const overview = useQuery(privacyOverviewQueryOptions());
  const [confirmExecute, setConfirmExecute] = useState(false);
  const [lastRun, setLastRun] = useState<RetentionRun>();
  const [search, setSearch] = useState('');
  const [modes, setModes] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [filterOpen, setFilterOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const start = useMutation({
    mutationFn: (mode: RetentionRun['mode']) => startRetentionRun({ mode }),
    onSuccess: async (run) => {
      setLastRun(run);
      setConfirmExecute(false);
      await client.invalidateQueries({ queryKey: [...privacyQueryKey, 'runs'] });
    },
  });

  const term = search.trim().toLowerCase();
  const allRuns = (runs.data?.runs ?? []).filter((run): run is RetentionRun & { id: string } => Boolean(run.id));
  const filtered = allRuns.filter(
    (run) =>
      (modes.length === 0 || modes.includes(run.mode)) && (statuses.length === 0 || statuses.includes(run.status)),
  );
  const firstIds = new Set(filtered.slice((page - 1) * pageSize, page * pageSize).map((run) => run.id));
  // List rows carry no items. The page's runs load their detail for the result column; a search needs all of them.
  const details = useQueries({
    queries: filtered.map((run) => ({
      ...retentionRunQueryOptions(run.id),
      enabled: term !== '' || firstIds.has(run.id) || expanded.has(run.id),
    })),
  });
  const itemsOf = new Map(filtered.map((run, index) => [run.id, details[index]?.data?.items] as const));

  if (runs.isPending || categories.isPending) return <SettingsLoading label="Loading execution history" />;
  if (runs.isError) return <ErrorState message={runs.error.message} onRetry={() => void runs.refetch()} />;
  if (categories.isError) {
    return <ErrorState message={categories.error.message} onRetry={() => void categories.refetch()} />;
  }

  const categoryList = categories.data.categories;
  const matches = (run: RetentionRun & { id: string }) => {
    if (term === '') return true;
    const names = (itemsOf.get(run.id) ?? []).map((item) => categoryName(categoryList, item.categoryId));
    const haystack = [
      ...names,
      actorText(run),
      run.actorAccountId ?? '',
      formatDateTime(run.startedAt),
      startedLine(run.startedAt),
      formatLongDate(run.startedAt),
    ];
    return haystack.some((text) => text.toLowerCase().includes(term));
  };
  const matched = filtered.filter(matches);
  const visible = matched.slice((page - 1) * pageSize, page * pageSize);
  const byId = new Map(visible.map((run) => [run.id, run]));
  const rows = visible.map((run) => ({ id: run.id }));
  const filterCount = modes.length + statuses.length;

  const toggle = (list: string[], id: string, checked: boolean) =>
    checked ? [...list.filter((item) => item !== id), id] : list.filter((item) => item !== id);
  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const askExecute = () => {
    start.reset();
    setConfirmExecute(true);
  };

  const lastSummary = lastRun ? summarize(lastRun.items) : undefined;
  const lastId = lastRun?.id ?? null;
  const policies = overview.data;

  return (
    <Stack gap={5}>
      <p className="cds--type-body-compact-01">
        Every retention run, with what it changed per data category. A dry run uses the same rules and changes nothing.
        Counts only, never records.
      </p>
      {start.isError && !confirmExecute && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Run not started"
          subtitle={privacyErrorMessage(start.error)}
        />
      )}
      {lastRun && lastId === null && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Nothing to do"
          subtitle="Nothing to do: no active policy or legacy routine applied."
        />
      )}
      {lastRun && lastId !== null && lastSummary && (
        <RichNotification
          kind={lastRun.status === 'failed' ? 'warning' : 'success'}
          title={lastRun.mode === 'dry_run' ? 'Dry run finished' : 'Run finished'}
        >
          {lastRun.status === 'failed' && `The run failed${lastRun.errorCode ? ` (${lastRun.errorCode})` : ''}. `}
          {plural(lastSummary.categories, 'category', 'categories')}{' '}
          {lastRun.mode === 'dry_run' ? 'would change' : 'changed'} {plural(lastSummary.rows, 'row', 'rows')}.{' '}
          {skippedText(lastSummary) ? `${skippedText(lastSummary)}. ` : ''}
          {lastRun.mode === 'dry_run' ? 'Nothing was changed. ' : ''}
          <CarbonLink
            href={`#run-${lastId}`}
            onClick={(event) => {
              event.preventDefault();
              setSearch('');
              setModes([]);
              setStatuses([]);
              setPage(1);
              setExpanded((current) => new Set(current).add(lastId));
            }}
          >
            Open the result
          </CarbonLink>
        </RichNotification>
      )}
      {policies && (
        <p className="cds--type-helper-text-01">
          Automatic runs are <strong>{policies.automaticRunsEnabled ? 'on' : 'off'}</strong>
          {policies.automaticRunsEnabled ? '' : ": admin cleanup runs from the server's scheduler"} ·{' '}
          <PrivacyLink section="settings" size="sm">
            Change in Settings
          </PrivacyLink>
          {' | '}
          {plural(policies.policiesActive, 'active policy', 'active policies')},{' '}
          {plural(policies.policiesPending, 'draft', 'drafts')} not in force ·{' '}
          <PrivacyLink section="categories" size="sm">
            Edit per category
          </PrivacyLink>
        </p>
      )}
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            <TableToolbar>
              <TableToolbarContent>
                <TableToolbarSearch
                  persistent
                  labelText="Search runs"
                  placeholder="Search runs by category, actor or date"
                  value={search}
                  onChange={(event) => {
                    setSearch(typeof event === 'string' ? event : event.target.value);
                    setPage(1);
                  }}
                />
                <Popover open={filterOpen} align="bottom-end" onRequestClose={() => setFilterOpen(false)} dropShadow>
                  <Button
                    kind="ghost"
                    renderIcon={Filter}
                    aria-expanded={filterOpen}
                    onClick={() => setFilterOpen((open) => !open)}
                  >
                    {filterCount > 0 ? `Filter (${filterCount})` : 'Filter'}
                  </Button>
                  <PopoverContent>
                    <div style={{ padding: 'var(--cds-spacing-05)' }}>
                      <Stack gap={5}>
                        <CheckboxGroup legendText="Mode">
                          {modeFilters.map((option) => (
                            <Checkbox
                              key={option.id}
                              id={`run-filter-mode-${option.id}`}
                              labelText={option.label}
                              checked={modes.includes(option.id)}
                              onChange={(_, { checked }) => {
                                setModes((current) => toggle(current, option.id, checked));
                                setPage(1);
                              }}
                            />
                          ))}
                        </CheckboxGroup>
                        <CheckboxGroup legendText="Status">
                          {statusFilters.map((option) => (
                            <Checkbox
                              key={option.id}
                              id={`run-filter-status-${option.id}`}
                              labelText={option.label}
                              checked={statuses.includes(option.id)}
                              onChange={(_, { checked }) => {
                                setStatuses((current) => toggle(current, option.id, checked));
                                setPage(1);
                              }}
                            />
                          ))}
                        </CheckboxGroup>
                      </Stack>
                    </div>
                  </PopoverContent>
                </Popover>
                {canExecute && (
                  <>
                    <Button
                      kind="primary"
                      disabled={start.isPending}
                      onClick={() => {
                        start.reset();
                        start.mutate('dry_run');
                      }}
                    >
                      Dry run
                    </Button>
                    <Button kind="danger" disabled={start.isPending} onClick={askExecute}>
                      Execute now
                    </Button>
                  </>
                )}
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()} aria-label="Retention runs">
              <TableHead>
                <TableRow>
                  <TableExpandHeader aria-label="Expand to see items" />
                  {tableHeaders.map((header) => {
                    const { key, ...props } = getHeaderProps({ header });
                    return (
                      <TableHeader key={key} {...props}>
                        {header.header}
                      </TableHeader>
                    );
                  })}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  const run = byId.get(row.id);
                  if (!run) return null;
                  const { key, ...rowProps } = getRowProps({ row });
                  const isExpanded = expanded.has(run.id);
                  const items = itemsOf.get(run.id);
                  const summary = items ? summarize(items) : undefined;
                  return [
                    <TableExpandRow
                      key={key}
                      {...rowProps}
                      id={`run-${run.id}`}
                      isExpanded={isExpanded}
                      onExpand={() => toggleExpanded(run.id)}
                      expandHeader="Expand to see items"
                    >
                      <TableCell>
                        <strong>{startedLine(run.startedAt)}</strong>
                        <div className="cds--type-helper-text-01">{formatLongDate(run.startedAt)}</div>
                      </TableCell>
                      <TableCell>{modeTag(run)}</TableCell>
                      <TableCell>
                        {run.trigger === 'manual' ? (
                          <>
                            Manual run
                            {run.actorAccountId && (
                              <div className="cds--type-helper-text-01">Account {run.actorAccountId}</div>
                            )}
                          </>
                        ) : (
                          <>
                            <code>admin cleanup</code> <span className="cds--type-helper-text-01">(scheduler)</span>
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        {summary ? (
                          <>
                            <Stack orientation="horizontal" gap={3}>
                              <StatusIcon run={run} />
                              <span>
                                {run.status === 'failed'
                                  ? `Failed${run.errorCode ? `: ${run.errorCode}` : ''}`
                                  : resultText(run, summary)}
                              </span>
                              {summary.failed > 0 && <WarningFilled size={16} aria-label="Some categories failed" />}
                            </Stack>
                            {skippedText(summary) && (
                              <div className="cds--type-helper-text-01">{skippedText(summary)}</div>
                            )}
                          </>
                        ) : (
                          <SkeletonText width="60%" />
                        )}
                      </TableCell>
                      <TableCell>{durationText(run)}</TableCell>
                    </TableExpandRow>,
                    <TableExpandedRow key={`${key}-items`} colSpan={tableHeaders.length + 1}>
                      {isExpanded &&
                        (items ? (
                          <RunDetail
                            run={run}
                            items={items}
                            categories={categoryList}
                            canExecute={canExecute}
                            busy={start.isPending}
                            onExecute={askExecute}
                          />
                        ) : (
                          <SettingsLoading label="Loading run items" />
                        ))}
                    </TableExpandedRow>,
                  ];
                })}
              </TableBody>
            </Table>
            {rows.length === 0 && (
              <p className="cds--type-helper-text-01">
                {allRuns.length === 0 ? 'No retention runs yet.' : 'No runs match the search or filter.'}
              </p>
            )}
          </TableContainer>
        )}
      </DataTable>
      {matched.length > 10 ? (
        <Pagination
          page={page}
          pageSize={pageSize}
          pageSizes={[10, 25, 50]}
          totalItems={matched.length}
          itemsPerPageText="Runs per page"
          itemRangeText={(min, max, total) => `Showing ${min}–${max} of ${total} runs`}
          onChange={({ page: nextPage, pageSize: nextSize }) => {
            setPage(nextPage);
            setPageSize(nextSize);
          }}
        />
      ) : (
        <p className="cds--type-helper-text-01">
          Showing {matched.length} of {allRuns.length} runs
        </p>
      )}
      <DestructiveActionDialog
        open={confirmExecute}
        title="Execute retention run"
        confirmLabel="Execute"
        pending={start.isPending}
        error={start.isError ? privacyErrorMessage(start.error) : undefined}
        onClose={() => setConfirmExecute(false)}
        onConfirm={() => start.mutate('execute')}
      >
        <p>This removes data according to the active policies. Run a dry run first to see what would be affected.</p>
      </DestructiveActionDialog>
    </Stack>
  );
}
