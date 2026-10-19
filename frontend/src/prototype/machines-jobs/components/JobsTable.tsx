import { BillingTag } from './BillingTag';
import type { ReactNode } from 'react';
import { DataTable, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@carbon/react';
import { Link, useNavigate } from 'react-router-dom';
import { effectivePrice, formatDateTime, formatMoney, jobStatus, JobRowStatusTag, jobName } from '../derived';
import { useNow, useStore } from '../store';
import type { Job } from '../types';
import '../styles/jobs.scss';

type Props = { jobs: Job[]; hideMachine?: boolean; size?: 'sm' | 'md' | 'lg'; title?: string; emptyState?: ReactNode };

const sortRow = (a: unknown, b: unknown, { sortDirection }: { sortDirection: string }) => {
  const result = typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), 'en', { numeric: true });
  return sortDirection === 'DESC' ? -result : result;
};

export function JobsTable({ jobs, hideMachine = false, size = 'lg', title, emptyState }: Props) {
  const { machines, prints } = useStore();
  const now = useNow();
  const navigate = useNavigate();
  if (jobs.length === 0 && emptyState) return <>{emptyState}</>;

  const machineName = (job: Job) => machines.find((machine) => machine.id === job.machineId)?.name ?? 'Unknown machine';
  const headers = [
    { key: 'job', header: 'Job', isSortable: true },
    ...(hideMachine ? [] : [{ key: 'machine', header: 'Machine', isSortable: true }]),
    { key: 'customer', header: 'Customer', isSortable: true },
    { key: 'status', header: 'Status', isSortable: false },
    { key: 'price', header: 'Price', isSortable: true },
  ];
  const rows = jobs.map((job) => ({
    id: job.id, job: job.startsAt, machine: machineName(job), customer: job.customer.displayName, status: jobStatus(job, prints.find((print) => print.id === job.printId), now), price: effectivePrice(job) ?? -1,
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
                  return <TableHeader key={key} {...props} className={header.key === 'machine' || header.key === 'customer' ? 'mj-hide-narrow' : undefined}>{header.header}</TableHeader>;
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
                  <TableRow key={key} {...rowProps} className="mj-table-row" onClick={() => navigate(`/jobs/${job.id}`)}>
                    <TableCell>
                      <div className="mj-title-with-thumb">
                        <div className="mj-cell-stack">
                          <Link to={`/jobs/${job.id}`} onClick={(event) => event.stopPropagation()}>{jobName(job, prints.find((print) => print.id === job.printId))}</Link>
                          <span className="mj-secondary">{job.displayId} · {formatDateTime(job.startsAt)}</span>
                          {!hideMachine && <span className="mj-secondary mj-show-narrow">{machineName(job)}</span>}
                        </div>
                      </div>
                    </TableCell>
                    {!hideMachine && <TableCell className="mj-hide-narrow">{machineName(job)}</TableCell>}
                    <TableCell className="mj-hide-narrow">
                      <div className="mj-cell-stack">
                        <span>{job.customer.displayName}</span>
                        {job.operator && <span className="mj-secondary">{job.operator.displayName}</span>}
                      </div>
                    </TableCell>
                    <TableCell><JobRowStatusTag status={jobStatus(job, prints.find((print) => print.id === job.printId), now)} size="sm" /></TableCell>
                    <TableCell>
                      <div className="mj-cell-stack">
                        <span>{formatMoney(effectivePrice(job))}</span>
                        <span><BillingTag job={job} /></span>
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
