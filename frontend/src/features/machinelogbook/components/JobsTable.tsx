import type { ReactNode } from 'react';
import {
  DataTable,
  Link as CarbonLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@carbon/react';
import { Link, useNavigate } from 'react-router-dom';
import type { WorkItem } from '../../../api/generated/models';
import { formatDateTime, formatMoney } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { BillingTag, JobRowStatusTag, workItemName } from '../shared/status';
import '../styles/jobs.scss';

type Props = {
  jobs: WorkItem[];
  hideMachine?: boolean;
  size?: 'sm' | 'md' | 'lg';
  title?: string;
  emptyState?: ReactNode;
};

const sortRow = (a: unknown, b: unknown, { sortDirection }: { sortDirection: string }) => {
  const result =
    typeof a === 'number' && typeof b === 'number'
      ? a - b
      : String(a).localeCompare(String(b), 'en', { numeric: true });
  return sortDirection === 'DESC' ? -result : result;
};

const hrefOf = (item: WorkItem) =>
  item.kind === 'run' ? machineLogbookPaths.run(item.id) : machineLogbookPaths.job(item.id);

/** Plain sortable table of work items (jobs and unassigned runs), for places that embed a short list. */
export function JobsTable({ jobs, hideMachine = false, size = 'lg', title, emptyState }: Props) {
  const navigate = useNavigate();
  if (jobs.length === 0 && emptyState) return <>{emptyState}</>;

  const headers = [
    { key: 'job', header: 'Job', isSortable: true },
    ...(hideMachine ? [] : [{ key: 'machine', header: 'Machine', isSortable: true }]),
    { key: 'customer', header: 'Recipient', isSortable: true },
    { key: 'status', header: 'Status', isSortable: false },
    { key: 'price', header: 'Price', isSortable: true },
  ];
  const rows = jobs.map((job) => ({
    id: job.id,
    job: job.startedAt,
    machine: job.machineName,
    customer: job.customer?.displayName ?? '',
    status: job.status,
    price: job.effectivePrice == null ? -1 : Number(job.effectivePrice),
  }));

  return (
    <DataTable rows={rows} headers={headers} size={size} sortRow={sortRow} isSortable>
      {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
        <TableContainer title={title}>
          <Table {...getTableProps()} aria-label={title ?? 'Jobs'}>
            <TableHead>
              <TableRow>
                {tableHeaders.map((header) => {
                  const { key, ...props } = getHeaderProps({ header, isSortable: header.isSortable });
                  return (
                    <TableHeader
                      key={key}
                      {...props}
                      className={header.key === 'machine' || header.key === 'customer' ? 'mj-hide-narrow' : undefined}
                    >
                      {header.header}
                    </TableHeader>
                  );
                })}
              </TableRow>
            </TableHead>
            <TableBody>
              {tableRows.map((row) => {
                // DataTable keeps its previous rows for one render after the jobs prop changes.
                const job = jobs.find((item) => item.id === row.id);
                if (!job) return null;
                const { key, ...rowProps } = getRowProps({ row });
                return (
                  <TableRow key={key} {...rowProps} className="mj-table-row" onClick={() => navigate(hrefOf(job))}>
                    <TableCell>
                      <div className="mj-cell-stack">
                        <CarbonLink
                          as={Link}
                          to={hrefOf(job)}
                          onClick={(event: { stopPropagation: () => void }) => event.stopPropagation()}
                        >
                          {workItemName(job)}
                        </CarbonLink>
                        <span className="mj-secondary">
                          {job.displayId} · {formatDateTime(job.startedAt)}
                        </span>
                        {!hideMachine && <span className="mj-secondary mj-show-narrow">{job.machineName}</span>}
                      </div>
                    </TableCell>
                    {!hideMachine && <TableCell className="mj-hide-narrow">{job.machineName}</TableCell>}
                    <TableCell className="mj-hide-narrow">
                      <div className="mj-cell-stack">
                        <span>{job.customer?.displayName ?? '—'}</span>
                        {job.operator && <span className="mj-secondary">{job.operator.displayName}</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <JobRowStatusTag status={job.status} size="sm" />
                    </TableCell>
                    <TableCell>
                      <div className="mj-cell-stack">
                        <span>{formatMoney(job.effectivePrice)}</span>
                        <span>
                          <BillingTag billing={job.billing} />
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </DataTable>
  );
}
