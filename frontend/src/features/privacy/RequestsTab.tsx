import { ArrowRight, Checkmark, CheckmarkFilled, Filter } from '@carbon/icons-react';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  ClickableTile,
  DataTable,
  Link,
  Pagination,
  Popover,
  PopoverContent,
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
  Tag,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import type { SubjectRequest, SubjectRequestKind, SubjectRequestStatus } from '../../api/generated/models';
import { formatDate } from '../../app/dateTime';
import { ErrorState } from '../../app/PageState';
import { useNow } from '../../app/useNow';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import { subjectRequestsQueryOptions } from './privacy';
import { privacyPath, requestPath } from './privacyNavigation';
import {
  channelPhrases,
  dueInfo,
  isClosed,
  isClosedThisYear,
  isDueSoon,
  kindLabels,
  nextStep,
  personLabel,
  requestProgress,
  statusDetail,
  statusLabels,
  statusSentence,
  type Actor,
} from './privacyRequests';
import { RecordRequestModal } from './RecordRequestModal';
import './privacyCategories.scss';
import './privacyRequests.scss';

const headers = [
  { key: 'who', header: 'Who and what' },
  { key: 'stands', header: 'Where it stands' },
  { key: 'next', header: 'Next step' },
  { key: 'received', header: 'Received' },
  { key: 'due', header: 'Due' },
];

type TileFilter = 'mine' | 'waiting' | 'due' | 'closed';

type Filters = { kinds: SubjectRequestKind[]; statuses: SubjectRequestStatus[] };

const noFilters: Filters = { kinds: [], statuses: [] };

function toggled<T extends string>(list: readonly T[], value: T, checked: boolean): T[] {
  return checked ? [...list.filter((item) => item !== value), value] : list.filter((item) => item !== value);
}

function ProgressBar({ request }: { request: SubjectRequest }) {
  const { done, stopped } = requestProgress(request);
  return (
    <div className="privacy-bar" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((step) => {
        const state =
          step <= done ? 'done' : step === done + 1 ? (stopped ? 'rejected' : isClosed(request) ? '' : 'current') : '';
        return <span key={step} className={`privacy-bar__segment${state ? ` privacy-bar__segment--${state}` : ''}`} />;
      })}
    </div>
  );
}

function FilterPanel({ filters, onChange }: { filters: Filters; onChange: (filters: Filters) => void }) {
  const [open, setOpen] = useState(false);
  const count = filters.kinds.length + filters.statuses.length;
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
            <div className="privacy-filter__panel" role="group" aria-label="Filter data requests">
              <CheckboxGroup legendText="Kind">
                {(Object.keys(kindLabels) as SubjectRequestKind[]).map((kind) => (
                  <Checkbox
                    key={kind}
                    id={`request-filter-kind-${kind}`}
                    labelText={kindLabels[kind]}
                    checked={filters.kinds.includes(kind)}
                    onChange={(_event, { checked }) =>
                      onChange({ ...filters, kinds: toggled(filters.kinds, kind, checked) })
                    }
                  />
                ))}
              </CheckboxGroup>
              <CheckboxGroup legendText="Status">
                {(Object.keys(statusLabels) as SubjectRequestStatus[]).map((status) => (
                  <Checkbox
                    key={status}
                    id={`request-filter-status-${status}`}
                    labelText={statusLabels[status]}
                    checked={filters.statuses.includes(status)}
                    onChange={(_event, { checked }) =>
                      onChange({ ...filters, statuses: toggled(filters.statuses, status, checked) })
                    }
                  />
                ))}
              </CheckboxGroup>
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
  alert,
  active,
  onSelect,
}: {
  label: string;
  value: number;
  alert?: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <ClickableTile
      href={privacyPath('requests')}
      aria-current={active ? 'true' : undefined}
      renderIcon={active ? CheckmarkFilled : ArrowRight}
      onClick={(event) => {
        event.preventDefault();
        onSelect();
      }}
    >
      <span className="privacy-tiles__label">{label}</span>
      <span className={`privacy-tiles__value${alert ? ' privacy-requests__due--late' : ''}`}>{value}</span>
    </ClickableTile>
  );
}

function matchesSearch(request: SubjectRequest, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  return (request.personName ?? '').toLowerCase().includes(needle) || request.reference.toLowerCase().includes(needle);
}

/** Open requests first, the most urgent on top; closed ones follow, newest due date first. */
function byUrgency(a: SubjectRequest, b: SubjectRequest): number {
  const closedOrder = Number(isClosed(a)) - Number(isClosed(b));
  if (closedOrder !== 0) return closedOrder;
  const order = new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime();
  return isClosed(a) ? -order : order;
}

export function RequestsTab() {
  const currentUser = useCurrentUser();
  const requests = useQuery(subjectRequestsQueryOptions());
  const now = useNow();
  const [recording, setRecording] = useState(false);
  const [search, setSearch] = useState('');
  const [openOnly, setOpenOnly] = useState(true);
  const [tile, setTile] = useState<TileFilter | null>(null);
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  if (requests.isPending) return <SettingsLoading label="Loading data requests" />;
  if (requests.isError) return <ErrorState message={requests.error.message} onRetry={() => void requests.refetch()} />;

  const actor: Actor = {
    accountId: currentUser.account.id,
    canManage: hasPermission(currentUser, 'privacy.requests.manage'),
    canExecute: hasPermission(currentUser, 'privacy.requests.execute'),
  };
  const all = requests.data.requests;
  const open = all.filter((request) => !isClosed(request));
  const counts = {
    mine: open.filter((request) => nextStep(request, actor).mine).length,
    waiting: open.filter((request) => !nextStep(request, actor).mine).length,
    due: all.filter((request) => isDueSoon(request, now)).length,
    closed: all.filter((request) => isClosedThisYear(request, now)).length,
  };
  const inTile: Record<TileFilter, (request: SubjectRequest) => boolean> = {
    mine: (request) => !isClosed(request) && nextStep(request, actor).mine,
    waiting: (request) => !isClosed(request) && !nextStep(request, actor).mine,
    due: (request) => isDueSoon(request, now),
    closed: (request) => isClosedThisYear(request, now),
  };
  const matched = all
    .filter(
      (request) =>
        matchesSearch(request, search) &&
        (tile ? inTile[tile](request) : !openOnly || !isClosed(request)) &&
        (filters.kinds.length === 0 || filters.kinds.includes(request.kind)) &&
        (filters.statuses.length === 0 || filters.statuses.includes(request.status)),
    )
    .sort(byUrgency);
  const lastPage = Math.max(1, Math.ceil(matched.length / pageSize));
  const currentPage = Math.min(page, lastPage);
  const visible = matched.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  // DataTable can render one pass with its previous rows, so look up in the full list.
  const byId = new Map(all.map((request) => [request.id as string, request]));
  const rows = visible.map((request) => ({ id: request.id as string }));
  const tileProps = (key: TileFilter) => ({
    active: tile === key,
    onSelect: () => {
      setTile(tile === key ? null : key);
      setPage(1);
    },
  });

  return (
    <Stack gap={5}>
      <div className="privacy-tiles">
        <SummaryTile label="Your move" value={counts.mine} {...tileProps('mine')} />
        <SummaryTile label="Waiting for someone else" value={counts.waiting} {...tileProps('waiting')} />
        <SummaryTile
          label="Due within 7 days or overdue"
          value={counts.due}
          alert={counts.due > 0}
          {...tileProps('due')}
        />
        <SummaryTile label="Closed this year" value={counts.closed} {...tileProps('closed')} />
      </div>
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            <TableToolbar>
              <TableToolbarContent>
                <TableToolbarSearch
                  labelText="Search data requests"
                  placeholder="Search by person or reference"
                  value={search}
                  onChange={(event) => {
                    setSearch(typeof event === 'string' ? event : event.target.value);
                    setPage(1);
                  }}
                />
                <Button
                  kind="ghost"
                  size="lg"
                  renderIcon={openOnly && !tile ? Checkmark : undefined}
                  aria-pressed={openOnly && !tile}
                  disabled={tile !== null}
                  onClick={() => {
                    setOpenOnly(!openOnly);
                    setPage(1);
                  }}
                >
                  Open only
                </Button>
                <FilterPanel
                  filters={filters}
                  onChange={(next) => {
                    setFilters(next);
                    setPage(1);
                  }}
                />
                <Button size="lg" onClick={() => setRecording(true)}>
                  Record a request
                </Button>
              </TableToolbarContent>
            </TableToolbar>
            <Table {...getTableProps()} aria-label="Data requests" className="privacy-requests__table">
              <TableHead>
                <TableRow>
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
                  const request = byId.get(row.id);
                  if (!request) return null;
                  const { key, ...rowProps } = getRowProps({ row });
                  const next = nextStep(request, actor);
                  const due = dueInfo(request, now);
                  return (
                    <TableRow key={key} {...rowProps}>
                      <TableCell>
                        <div className="privacy-requests__stands">
                          <div className="privacy-requests__person">
                            <Link as={RouterLink} to={requestPath(request.id)}>
                              {personLabel(request)}
                            </Link>
                          </div>
                          <div className="cds--type-helper-text-01">
                            {request.reference ? `${request.reference} · ` : ''}
                            {channelPhrases[request.channel]}
                          </div>
                          <Tag type={request.kind === 'erasure' ? 'blue' : 'purple'} size="sm">
                            {kindLabels[request.kind]}
                          </Tag>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="privacy-requests__stands">
                          <ProgressBar request={request} />
                          <div>{statusSentence(request)}</div>
                          <div className="cds--type-helper-text-01">{statusDetail(request)}</div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="privacy-requests__stands">
                          <div className="privacy-requests__person">{next.task}</div>
                          {(next.who || next.fact) && (
                            <div className="cds--type-helper-text-01">
                              {[next.who, next.fact].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{formatDate(request.receivedAt)}</TableCell>
                      <TableCell>
                        <div className="privacy-requests__stands">
                          <div className={`privacy-requests__due${due.late ? ' privacy-requests__due--late' : ''}`}>
                            {formatDate(request.dueAt)}
                          </div>
                          <div className={`cds--type-helper-text-01${due.late ? ' privacy-requests__due--late' : ''}`}>
                            {due.text}
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {matched.length === 0 && (
              <p className="privacy-requests__empty cds--type-body-compact-01">
                {all.length === 0 ? 'No data requests recorded.' : 'No data requests match.'}
              </p>
            )}
          </TableContainer>
        )}
      </DataTable>
      {matched.length > 10 ? (
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          pageSizes={[10, 25, 50]}
          totalItems={matched.length}
          itemsPerPageText="Requests per page"
          itemRangeText={(min, max, total) => `Showing ${min}–${max} of ${total} requests`}
          onChange={({ page: nextPage, pageSize: nextSize }) => {
            setPage(nextPage);
            setPageSize(nextSize);
          }}
        />
      ) : (
        <p className="cds--type-helper-text-01">
          Showing {matched.length} of {all.length} requests
        </p>
      )}
      {recording && <RecordRequestModal onClose={() => setRecording(false)} />}
    </Stack>
  );
}
