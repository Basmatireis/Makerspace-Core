import {
  Button,
  Checkbox,
  CheckboxGroup,
  ClickableTile,
  DataTable,
  Link,
  Popover,
  PopoverContent,
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
import { ArrowRight, CheckmarkFilled, CircleFilled, Filter, Locked } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import type {
  PrivacyCategory,
  PrivacyCategoryCoveragePolicyStatus,
  PrivacyOverview,
  RetentionAction,
  RetentionPolicy,
  RetentionRunItemSummary,
} from '../../api/generated/models';
import { ErrorState } from '../../app/PageState';
import { formatDate, formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import { privacyCategoriesQueryOptions, privacyOverviewQueryOptions, privacySettingsQueryOptions } from './privacy';
import { categoryRetentionPath, PrivacyLink, privacyPath } from './privacyNavigation';
import './privacyCategories.scss';

type Status = PrivacyCategoryCoveragePolicyStatus;

const triggerPhrases: Record<string, string> = {
  manual: 'by hand',
  scheduled: 'automatically',
  cli: 'via admin cleanup',
};

/** One line with the facts an operator checks first: last run, automatic runs, holds, orphaned categories. */
export function PrivacyContextLine({ overview }: { overview: PrivacyOverview }) {
  const currentUser = useCurrentUser();
  const settings = useQuery(privacySettingsQueryOptions());
  const run = overview.lastRun;
  const holds = overview.openCategoryHolds;
  const item = (label: string, value: ReactNode, link?: ReactNode) => (
    <div className="privacy-context__item">
      <span className="privacy-context__label">{label}</span>
      <span className="privacy-context__value">{value}</span>
      {link && <span className="privacy-context__link">{link}</span>}
    </div>
  );
  return (
    <div className="privacy-context">
      {item(
        'Last run',
        run ? (
          <>
            <strong>{formatDateTime(run.startedAt)}</strong> {triggerPhrases[run.trigger] ?? run.trigger},{' '}
            {run.mode === 'dry_run'
              ? `would change ${run.affectedCount} rows (dry run)`
              : `${run.affectedCount} rows changed`}
          </>
        ) : (
          <strong>none yet</strong>
        ),
        <PrivacyLink section="runs">Execution history</PrivacyLink>,
      )}
      {item(
        'Automatic runs',
        <>
          <strong>{overview.automaticRunsEnabled ? 'On' : 'Off'}</strong>
          {overview.automaticRunsEnabled ? '' : ', admin cleanup applies the policies'}
          {settings.data && settings.data.controllerName.trim() === '' ? ' · controller not named' : ''}
        </>,
        <PrivacyLink section="settings">Settings</PrivacyLink>,
      )}
      {item(
        'Holds',
        holds === 0 ? (
          'No category on hold'
        ) : (
          <>
            <strong>{holds}</strong> {holds === 1 ? 'category' : 'categories'} on hold
          </>
        ),
        <PrivacyLink section="holds">Holds</PrivacyLink>,
      )}
      {item(
        'Record of processing',
        overview.orphanedCategories > 0
          ? `${overview.orphanedCategories} orphaned ${overview.orphanedCategories === 1 ? 'category' : 'categories'} still hold data`
          : 'Which activities use which data',
        <PrivacyLink section="activities">Processing activities</PrivacyLink>,
      )}
      {hasPermission(currentUser, 'privacy.requests.manage') &&
        item(
          'People asking for their data',
          'Access and erasure requests',
          <PrivacyLink section="requests">Data requests</PrivacyLink>,
        )}
    </div>
  );
}

function moduleLabel(id: string): string {
  const text = id.replace(/[_-]+/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const subjectInfo: Record<
  PrivacyCategory['subject'],
  { label: string; hint: string; color: 'blue' | 'purple' | 'gray' }
> = {
  person: { label: 'A person', hint: 'Named member, guest or helper', color: 'blue' },
  account: { label: 'An account', hint: 'Only the login, not the person', color: 'purple' },
  none: { label: 'No person', hint: 'Not about anyone in particular', color: 'gray' },
};

const actionLabels: Record<RetentionAction, string> = {
  delete: 'Delete',
  anonymize: 'Anonymize',
  unlink: 'Unlink from the person',
  redact: 'Redact',
  retain_with_review: 'Keep, with review',
};
const actionPastTense: Record<RetentionAction, string> = {
  delete: 'deleted',
  anonymize: 'anonymized',
  unlink: 'unlinked',
  redact: 'redacted',
  retain_with_review: 'flagged for review',
};
const erasureText: Record<PrivacyCategory['erasure'], string> = {
  erased: 'Deleted with the person.',
  unlinked: 'Kept without the person link.',
  retained_legal: 'Kept for a legal obligation, without the person link.',
  manual_review: 'An operator must act first.',
  none: 'Not person-linked.',
};
const statusLabels: Record<Status, string> = {
  active: 'Policy in force',
  pending: 'Draft only',
  none: 'No decision yet',
};

const words = (value: string) => value.replace(/_/g, ' ');

function rule(policy: Pick<RetentionPolicy, 'periodDays' | 'trigger' | 'action'>): string {
  return `${policy.periodDays} days after ${policy.trigger} → ${policy.action}`;
}

function legacyDefaultText(category: PrivacyCategory): string {
  const legacy = category.legacyDefault;
  if (!legacy) return 'Never removed automatically';
  return `${rule(legacy)}, from ${legacy.source}`;
}

/** Tables and columns behind a category; a `table.*` field stands for whole rows. */
function footprint(fields: readonly string[]): string {
  const tables = new Set(fields.map((field) => field.split('.')[0]));
  const wholeRows = fields.some((field) => field.endsWith('.*'));
  const columns = fields.filter((field) => !field.endsWith('.*')).length;
  const tableText = `${tables.size} ${tables.size === 1 ? 'table' : 'tables'}`;
  if (columns === 0) return `${tableText}, whole rows`;
  return `${tableText}, ${columns} ${columns === 1 ? 'column' : 'columns'}${wholeRows ? ' and whole rows' : ''}`;
}

function storedWhere(fields: readonly string[]): { table: string; columns: string[] }[] {
  const grouped = new Map<string, string[]>();
  for (const field of fields) {
    const dot = field.indexOf('.');
    const table = dot < 0 ? field : field.slice(0, dot);
    const column = dot < 0 ? '*' : field.slice(dot + 1);
    grouped.set(table, [...(grouped.get(table) ?? []), column]);
  }
  return [...grouped].map(([table, columns]) => ({ table, columns }));
}

function runOutcome(run: RetentionRunItemSummary): string {
  switch (run.status) {
    case 'skipped_hold':
      return 'Skipped: on hold';
    case 'skipped_no_handler':
      return 'Skipped: no policy';
    case 'failed':
      return 'Failed';
    default:
      return run.mode === 'dry_run'
        ? `Would change ${run.affectedCount} rows (dry run)`
        : `${run.affectedCount} rows ${actionPastTense[run.action]}`;
  }
}

function runLine(run: RetentionRunItemSummary | null): string {
  if (!run) return 'No run yet';
  const outcome = runOutcome(run);
  // Skips and failures read as a state; a normal run is introduced as the last run.
  return run.status === 'applied'
    ? `Last run: ${outcome} (${formatDate(run.startedAt)})`
    : `${outcome} (${formatDate(run.startedAt)})`;
}

function statusInfo(category: PrivacyCategory) {
  const { policy, policyStatus } = category.coverage;
  const legacy = category.legacyDefault ? rule(category.legacyDefault) : undefined;
  const onHold = category.coverage.hold !== null;
  const prefix = onHold ? 'Paused by a hold: ' : '';
  if (policyStatus === 'active' && policy) {
    return { title: `${prefix}In force`, line: rule(policy), link: 'Edit retention', cta: 'Edit retention' };
  }
  if (policyStatus === 'pending' && policy) {
    return {
      title: `${prefix}Draft only`,
      line: `Draft: ${rule(policy)}. Today: ${legacy ?? 'kept indefinitely'}`,
      link: 'Edit retention',
      cta: 'Edit retention',
    };
  }
  return {
    title: `${prefix}No decision yet`,
    line: legacy ?? (category.subject === 'person' ? 'Kept until the person is deleted' : 'Kept indefinitely'),
    link: 'Edit retention',
    cta: 'Edit retention',
  };
}

function policyStatusText(category: PrivacyCategory): string {
  const { policy, policyStatus } = category.coverage;
  if (!policy) return 'None';
  if (policyStatus === 'active') return `Active v${policy.version}`;
  return policy.status === 'approved' ? `Approved v${policy.version}, not yet active` : 'Draft, not yet approved';
}

type Filters = { subjects: string[]; statuses: string[]; areas: string[]; special: string[] };
const noFilters: Filters = { subjects: [], statuses: [], areas: [], special: [] };

function matches(category: PrivacyCategory, search: string, filters: Filters): boolean {
  const needle = search.trim().toLowerCase();
  if (
    needle !== '' &&
    ![category.id, category.name, category.description, category.contains, ...category.fields].some((text) =>
      text.toLowerCase().includes(needle),
    )
  ) {
    return false;
  }
  if (filters.subjects.length > 0 && !filters.subjects.includes(category.subject)) return false;
  if (filters.statuses.length > 0 && !filters.statuses.includes(category.coverage.policyStatus)) return false;
  if (filters.areas.length > 0 && !filters.areas.includes(category.ownerModuleId)) return false;
  if (filters.special.includes('hold') && !category.coverage.hold) return false;
  if (filters.special.includes('orphaned') && !category.orphaned) return false;
  return true;
}

function toggled(list: readonly string[], value: string, checked: boolean): string[] {
  return checked ? [...list.filter((item) => item !== value), value] : list.filter((item) => item !== value);
}

function FilterPanel({
  categories,
  filters,
  onChange,
}: {
  categories: readonly PrivacyCategory[];
  filters: Filters;
  onChange: (filters: Filters) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = filters.subjects.length + filters.statuses.length + filters.areas.length + filters.special.length;
  const areas = [...new Set(categories.map((category) => category.ownerModuleId))].sort();
  const group = (legend: string, key: keyof Filters, options: readonly { id: string; label: string }[]) => (
    <CheckboxGroup legendText={legend}>
      {options.map((option) => (
        <Checkbox
          key={option.id}
          id={`privacy-filter-${key}-${option.id}`}
          labelText={option.label}
          checked={filters[key].includes(option.id)}
          onChange={(_event, { checked }) => onChange({ ...filters, [key]: toggled(filters[key], option.id, checked) })}
        />
      ))}
    </CheckboxGroup>
  );
  return (
    <div className="privacy-filter">
      <Popover open={open} align="bottom-end" isTabTip onRequestClose={() => setOpen(false)}>
        <Button
          kind="ghost"
          size="lg"
          renderIcon={Filter}
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
        >
          Filter
          {count > 0 && (
            <>
              {' '}
              <Tag as="span" type="blue" size="sm">
                {count}
              </Tag>
            </>
          )}
        </Button>
        <PopoverContent>
          {open && (
            <div className="privacy-filter__panel" role="group" aria-label="Filter categories">
              {group(
                'Belongs to',
                'subjects',
                (['person', 'account', 'none'] as const).map((id) => ({ id, label: subjectInfo[id].label })),
              )}
              {group(
                'Retention today',
                'statuses',
                (['active', 'pending', 'none'] as const).map((id) => ({ id, label: statusLabels[id] })),
              )}
              {group(
                'Area of the app',
                'areas',
                areas.map((id) => ({ id, label: moduleLabel(id) })),
              )}
              {group('Special cases', 'special', [
                { id: 'hold', label: 'On hold' },
                { id: 'orphaned', label: 'Orphaned' },
              ])}
              <div className="privacy-filter__actions">
                <Button kind="ghost" size="md" onClick={() => onChange(noFilters)}>
                  Clear filters
                </Button>
                <Button kind="primary" size="md" onClick={() => setOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function SummaryTile({
  label,
  value,
  note,
  active,
  onSelect,
}: {
  label: string;
  value: number;
  note?: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <ClickableTile
      href={privacyPath('categories')}
      aria-current={active ? 'true' : undefined}
      renderIcon={active ? CheckmarkFilled : ArrowRight}
      onClick={(event) => {
        event.preventDefault();
        onSelect();
      }}
    >
      <span className="privacy-tiles__label">
        {label}
        {note ? ` · ${note}` : ''}
      </span>
      <span className="privacy-tiles__value">{value}</span>
    </ClickableTile>
  );
}

function StatusDot({ status }: { status: Status }) {
  return <CircleFilled size={12} className={`privacy-status__dot privacy-status__dot--${status}`} aria-hidden="true" />;
}

function CategoryDetail({ category }: { category: PrivacyCategory }) {
  const navigate = useNavigate();
  const { policy, policyStatus, hold, lastRun, processingActivities } = category.coverage;
  const info = statusInfo(category);
  return (
    <>
      <p className="privacy-detail__lead">{category.description}</p>
      <div className="privacy-detail">
        <div className="privacy-detail__block">
          <h4 className="privacy-detail__heading">Where it is stored</h4>
          {storedWhere(category.fields).map((entry) => (
            <div key={entry.table}>
              <strong>{entry.table}</strong>
              <div>
                {entry.columns.map((column, index) => (
                  <span key={column}>
                    {index > 0 && ', '}
                    <code>{column}</code>
                  </span>
                ))}
              </div>
            </div>
          ))}
          <h4 className="privacy-detail__heading">Listed in processing activities</h4>
          {processingActivities.length > 0 ? (
            <ul>
              {processingActivities.map((activity) => (
                <li key={activity.id}>
                  <PrivacyLink section="activities">{activity.name}</PrivacyLink>
                </li>
              ))}
            </ul>
          ) : (
            <p className="privacy-secondary">Not named in any processing activity yet.</p>
          )}
        </div>
        <div className="privacy-detail__block">
          <h4 className="privacy-detail__heading">Decision of record</h4>
          <dl className="privacy-kv">
            <dt>Status</dt>
            <dd>{policyStatusText(category)}</dd>
            <dt>Rule</dt>
            <dd>{policy ? rule(policy) : '–'}</dd>
            <dt>Approved at</dt>
            <dd>{policy?.approvedAt ? formatDate(policy.approvedAt) : '–'}</dd>
            <dt>Active since</dt>
            <dd>{policyStatus === 'active' && policy?.activatedAt ? formatDate(policy.activatedAt) : '–'}</dd>
            <dt>Before the registry</dt>
            <dd>{legacyDefaultText(category)}</dd>
          </dl>
          <h4 className="privacy-detail__heading">Retention can</h4>
          <div>
            {category.actions.map((action) => (
              <Tag key={action} type="teal" size="sm">
                {actionLabels[action]}
              </Tag>
            ))}
          </div>
          <p>
            <span className="privacy-secondary">The clock starts:</span>{' '}
            {category.triggers.map(words).join(', ') || '–'}
          </p>
          <h4 className="privacy-detail__heading">When a person asks for erasure</h4>
          <p>{erasureText[category.erasure]}</p>
        </div>
        <div className="privacy-detail__block">
          <h4 className="privacy-detail__heading">Recent runs</h4>
          {lastRun ? (
            <div>
              <div>{runOutcome(lastRun)}</div>
              <div className="privacy-secondary">
                {formatDateTime(lastRun.startedAt)} · {triggerPhrases[lastRun.trigger] ?? lastRun.trigger}
              </div>
            </div>
          ) : (
            <p className="privacy-secondary">No run yet</p>
          )}
          {category.retentionNote && (
            <>
              <h4 className="privacy-detail__heading">Good to know</h4>
              <p className="privacy-secondary">{category.retentionNote}</p>
            </>
          )}
        </div>
      </div>
      <div className="privacy-detail__actions">
        <Button kind="tertiary" size="md" onClick={() => void navigate(privacyPath('holds'))}>
          {hold ? 'Release the hold' : 'Place a hold'}
        </Button>
        <Button kind="tertiary" size="md" onClick={() => void navigate(privacyPath('runs'))}>
          Dry run
        </Button>
        <Button kind="primary" size="md" onClick={() => void navigate(categoryRetentionPath(category.id))}>
          {info.cta}
        </Button>
      </div>
    </>
  );
}

const categoryHeaders = [
  { key: 'name', header: 'What the data is' },
  { key: 'subject', header: 'Belongs to' },
  { key: 'area', header: 'Area of the app' },
  { key: 'retention', header: 'Retention today' },
];

export function CategoriesTab() {
  const categories = useQuery(privacyCategoriesQueryOptions());
  const overview = useQuery(privacyOverviewQueryOptions());
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Filters>(noFilters);
  const list = categories.data?.categories;
  const filtered = useMemo(
    () => (list ?? []).filter((category) => matches(category, search, filters)),
    [list, search, filters],
  );

  if (categories.isPending) return <SettingsLoading label="Loading data categories" />;
  if (categories.isError) {
    return <ErrorState message={categories.error.message} onRetry={() => void categories.refetch()} />;
  }
  const allCategories = categories.data.categories;
  // DataTable can render one pass with its previous rows, so look up in the full list.
  const byId = new Map(allCategories.map((category) => [category.id as string, category]));
  const rows = filtered.map((category) => ({ id: category.id as string }));
  const statusFilter = filters.statuses.length === 1 ? filters.statuses[0] : filters.statuses.length === 0 ? '' : '*';
  const select = (status: '' | Status) => setFilters({ ...filters, statuses: status === '' ? [] : [status] });
  const data = overview.data;

  return (
    <Stack gap={5}>
      {data && (
        <div className="privacy-tiles">
          <SummaryTile
            label="All categories"
            note={`${data.orphanedCategories} orphaned`}
            value={data.categories}
            active={statusFilter === ''}
            onSelect={() => select('')}
          />
          <SummaryTile
            label="Policy in force"
            value={data.policiesActive}
            active={statusFilter === 'active'}
            onSelect={() => select('active')}
          />
          <SummaryTile
            label="Draft only, previous behaviour applies"
            value={data.policiesPending}
            active={statusFilter === 'pending'}
            onSelect={() => select('pending')}
          />
          <SummaryTile
            label="No decision yet, kept indefinitely"
            value={data.withoutPolicy}
            active={statusFilter === 'none'}
            onSelect={() => select('none')}
          />
        </div>
      )}
      {data && <PrivacyContextLine overview={data} />}
      <DataTable rows={rows} headers={categoryHeaders}>
        {({ rows: tableRows, headers, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            <TableToolbar>
              <TableToolbarContent>
                <TableToolbarSearch
                  labelText="Search data categories"
                  placeholder="Search by what it contains, e.g. matriculation number, e-mail, timelapse"
                  value={search}
                  onChange={(event) => setSearch(typeof event === 'string' ? event : event.target.value)}
                />
                <FilterPanel categories={allCategories} filters={filters} onChange={setFilters} />
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()} aria-label="Data categories" className="privacy-table">
              <TableHead>
                <TableRow>
                  <TableExpandHeader aria-label="Expand to see where the data is stored" />
                  {headers.map((header) => {
                    const { key, ...props } = getHeaderProps({ header });
                    return (
                      <TableHeader key={key} {...props} className={`privacy-col privacy-col--${header.key}`}>
                        {header.header}
                      </TableHeader>
                    );
                  })}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  const category = byId.get(row.id)!;
                  const { key, ...rowProps } = getRowProps({ row });
                  const info = statusInfo(category);
                  const subject = subjectInfo[category.subject];
                  const coverage = category.coverage;
                  const activities = coverage.processingActivities.length;
                  return [
                    <TableExpandRow
                      key={key}
                      {...rowProps}
                      aria-label={`Show where ${category.name} is stored`}
                      expandHeader="Expand to see where the data is stored"
                    >
                      <TableCell>
                        <div className="privacy-cell">
                          <div>
                            <strong>{category.name}</strong>{' '}
                            {category.orphaned && (
                              <Tag type="red" size="sm">
                                Orphaned
                              </Tag>
                            )}
                          </div>
                          <div>{category.contains}</div>
                          <div className="cds--type-helper-text-01">
                            {footprint(category.fields)} ·{' '}
                            {activities > 0
                              ? `in ${activities} processing ${activities === 1 ? 'activity' : 'activities'}`
                              : 'not in any processing activity'}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="privacy-cell">
                          <Tag type={subject.color} size="sm">
                            {subject.label}
                          </Tag>
                          <div className="cds--type-helper-text-01">{subject.hint}</div>
                        </div>
                      </TableCell>
                      <TableCell>{moduleLabel(category.ownerModuleId)}</TableCell>
                      <TableCell>
                        <div className="privacy-status">
                          <StatusDot status={coverage.policyStatus} />
                          <div className="privacy-cell">
                            <strong>{info.title}</strong>
                            <div className="privacy-secondary">{info.line}</div>
                            {coverage.hold && (
                              <div className="privacy-hold">
                                <Locked size={16} aria-hidden="true" />
                                <span>
                                  On hold since {formatDate(coverage.hold.createdAt)}: {coverage.hold.reason}
                                </span>
                              </div>
                            )}
                            <div className="cds--type-helper-text-01">{runLine(coverage.lastRun)}</div>
                            <Link as={RouterLink} to={categoryRetentionPath(category.id)}>
                              {info.link}
                            </Link>
                          </div>
                        </div>
                      </TableCell>
                    </TableExpandRow>,
                    <TableExpandedRow
                      key={`${key}-detail`}
                      colSpan={headers.length + 1}
                      className="privacy-table__detail"
                    >
                      <CategoryDetail category={category} />
                    </TableExpandedRow>,
                  ];
                })}
              </TableBody>
            </Table>
            {filtered.length === 0 && <p className="cds--type-helper-text-01">No data categories match.</p>}
          </TableContainer>
        )}
      </DataTable>
      <p className="cds--type-helper-text-01">
        Technical identifiers and column names are shown only in the opened row. The categories themselves are declared
        in the application code and cannot be edited here.
      </p>
    </Stack>
  );
}
