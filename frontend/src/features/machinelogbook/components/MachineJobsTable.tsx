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
import { AttentionFlag, attentionColumn, attentionColumnClassName } from '../../../app/components/AttentionFlag';
import { formatDuration, formatRelative } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { BillingTag, JobRowStatusTag, workItemName } from '../shared/status';

const headers = [
  { key: 'job', header: 'Job' },
  { key: 'recipient', header: 'Recipient' },
  { key: 'started', header: 'Started' },
  { key: 'status', header: 'Outcome' },
  { key: 'billing', header: 'Billing' },
  { key: attentionColumn.key, header: attentionColumn.header },
];

const hrefOf = (item: WorkItem) =>
  item.kind === 'run' ? machineLogbookPaths.run(item.id) : machineLogbookPaths.job(item.id);

const durationOf = (item: WorkItem) => {
  const end = item.endsAt ? new Date(item.endsAt).getTime() : Date.now();
  return Math.max(0, Math.round((end - new Date(item.startedAt).getTime()) / 1000));
};

/**
 * The jobs of one machine on its page: job, recipient and operator, start and duration, outcome, billing and the
 * attention flag. A row opens the job (or the unassigned run).
 */
export function MachineJobsTable({ jobs, label = 'Jobs' }: { jobs: WorkItem[]; label?: string }) {
  const navigate = useNavigate();
  return (
    <DataTable rows={jobs.map((job) => ({ id: job.id }))} headers={headers} size="md">
      {({ rows, getTableProps, getRowProps }) => (
        <TableContainer className="mj-table-container mj-scroll-x">
          <Table {...getTableProps()} aria-label={label}>
            <TableHead>
              <TableRow>
                {headers.map((header) =>
                  header.key === attentionColumn.key ? (
                    <TableHeader key={header.key} className={attentionColumnClassName}>
                      <span className="cds--visually-hidden">{header.header}</span>
                    </TableHeader>
                  ) : (
                    <TableHeader
                      key={header.key}
                      className={['recipient', 'billing'].includes(header.key) ? 'mj-hide-narrow' : undefined}
                    >
                      {header.header}
                    </TableHeader>
                  ),
                )}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => {
                // DataTable keeps its previous rows for one render after the jobs prop changes.
                const job = jobs.find((item) => item.id === row.id);
                if (!job) return null;
                const { key, ...rowProps } = getRowProps({ row });
                const running = job.status === 'running' || job.status === 'running_unassigned';
                return (
                  <TableRow
                    key={key}
                    {...rowProps}
                    className="mj-row-clickable"
                    onClick={(event) => {
                      if (!(event.target as HTMLElement).closest('a, button')) navigate(hrefOf(job));
                    }}
                  >
                    <TableCell className="mj-col-wide">
                      <div className="mj-cell-stack">
                        <CarbonLink as={Link} to={hrefOf(job)}>
                          {workItemName(job)}
                        </CarbonLink>
                        <span className="mj-secondary">{job.displayId}</span>
                      </div>
                    </TableCell>
                    <TableCell className="mj-hide-narrow">
                      <div className="mj-cell-stack">
                        <span>{job.customer?.displayName ?? '—'}</span>
                        {job.operator && <span className="mj-secondary">{job.operator.displayName}</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      {job.status === 'planned' ? (
                        <span className="mj-secondary">Planned</span>
                      ) : (
                        <div className="mj-cell-stack">
                          <span>{formatRelative(job.startedAt)}</span>
                          <span className="mj-secondary">
                            {formatDuration(durationOf(job))}
                            {running ? ' so far' : ''}
                          </span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <JobRowStatusTag status={job.status} size="sm" />
                    </TableCell>
                    <TableCell className="mj-hide-narrow">
                      {job.billing ? <BillingTag billing={job.billing} /> : <span className="mj-secondary">—</span>}
                    </TableCell>
                    <TableCell className={attentionColumnClassName}>
                      <AttentionFlag attention={job.attention} />
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
