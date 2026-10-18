import { useMemo, useState } from 'react';
import {
  Button, Checkbox, InlineNotification, Link as CarbonLink, Table, TableBody, TableCell, TableContainer, TableExpandHeader, TableExpandRow, TableExpandedRow, TableHead, TableHeader, TableRow,
  TableToolbar, TableToolbarContent, TableToolbarSearch, Tag,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { formatDateTimeRange } from '../../../../app/dateTime';
import { EmptyState } from '../../../../app/PageState';
import { RunThumb } from '../../components/RunPreview';
import { jobName } from '../../derived';
import { useNow, useStore } from '../../store';
import type { Job, Print } from '../../types';
import { formatDate, formatEur } from '../format';
import { readyToBill } from '../logic';
import type { Order } from '../types';

/** Finished jobs without an order, grouped by customer. Jobs that cannot be charged stay visible with the reason. Creates one draft per customer. */
export function ReadyToBillTab({ jobs, orders, prints, canCreate }: { jobs: Job[]; orders: Order[]; prints: Print[]; canCreate: boolean }) {
  const store = useStore();
  const navigate = useNavigate();
  const now = useNow();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => readyToBill(jobs, orders, prints, now), [jobs, orders, prints, now]);
  const visible = groups.filter((group) => !search || `${group.customer.displayName} ${group.rows.map((row) => jobName(row.job, prints.find((print) => print.id === row.job.printId))).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const toggle = (set: Set<string>, id: string) => { const next = new Set(set); if (!next.delete(id)) next.add(id); return next; };
  const selectedGroups = groups.filter((group) => group.ready.some((row) => selected.has(row.job.id)));

  const create = () => {
    setError(null);
    try {
      const created = selectedGroups.map((group) => store.createDraftFromJobs(group.customer, group.ready.filter((row) => selected.has(row.job.id)).map((row) => row.job.id)).orderId);
      store.notify({
        kind: 'success', title: `${created.length} draft ${created.length === 1 ? 'order' : 'orders'} created`, subtitle: `${selected.size} ${selected.size === 1 ? 'job' : 'jobs'} added. Review and finalize them.`,
        action: created.length === 1 ? { label: 'Open order', to: `/sales/orders/${created[0]}` } : { label: 'View orders', to: '/sales/orders' },
      });
      setSelected(new Set());
      if (created.length === 1) navigate(`/sales/orders/${created[0]}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The orders could not be created.'); }
  };

  if (groups.length === 0) return <EmptyState title="Nothing to bill" description="Finished jobs with a customer show up here until they are on an order." />;

  return (
    <TableContainer className="mj-table-container">
      <TableToolbar aria-label="Ready to bill toolbar">
        <TableToolbarContent>
          <TableToolbarSearch id="ready-search" labelText="Search customers and jobs" placeholder="Search customers and jobs" onChange={(_event, value) => setSearch(value ?? '')} onClear={() => setSearch('')} />
          {canCreate && <Button kind="primary" size="lg" renderIcon={Add} disabled={selected.size === 0} onClick={create}>{selected.size ? `Create ${selectedGroups.length} ${selectedGroups.length === 1 ? 'order' : 'orders'} (${selected.size} ${selected.size === 1 ? 'job' : 'jobs'})` : 'Create order'}</Button>}
        </TableToolbarContent>
      </TableToolbar>
      {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not create the orders" subtitle={error} />}
      <Table aria-label="Jobs ready to bill">
        <TableHead>
          <TableRow>
            <TableExpandHeader aria-label="Expand to see the jobs" />
            {canCreate && <TableHeader><span className="cds--visually-hidden">Select customer</span></TableHeader>}
            <TableHeader>Customer</TableHeader><TableHeader>Jobs</TableHeader><TableHeader className="sales-num">Ready total</TableHeader><TableHeader className="mj-hide-narrow">Oldest job</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {visible.length === 0 && <TableRow><TableCell colSpan={6}>No customer matches the search.</TableCell></TableRow>}
          {visible.map((group) => {
            const open = expanded.has(group.customer.id);
            const chosen = group.ready.filter((row) => selected.has(row.job.id)).length;
            const blocked = group.rows.length - group.ready.length;
            return [
              <TableExpandRow key={group.customer.id} isExpanded={open} aria-label={`Show the jobs of ${group.customer.displayName}`} onExpand={() => setExpanded((current) => toggle(current, group.customer.id))}>
                {canCreate && (
                  <TableCell>
                    <Checkbox id={`ready-group-${group.customer.id}`} labelText={`Select all ready jobs of ${group.customer.displayName}`} hideLabel disabled={group.ready.length === 0}
                      checked={chosen > 0 && chosen === group.ready.length} indeterminate={chosen > 0 && chosen < group.ready.length}
                      onChange={(_event, { checked }) => setSelected((current) => { const next = new Set(current); group.ready.forEach((row) => checked ? next.add(row.job.id) : next.delete(row.job.id)); return next; })} />
                  </TableCell>
                )}
                <TableCell><div className="mj-cell-stack"><strong>{group.customer.displayName}</strong><span className="mj-secondary">{group.customer.kind === 'organization' ? 'Organization' : 'Person'} · {group.customer.pricingGroup} prices</span></div></TableCell>
                <TableCell><span className="mj-inline">{group.ready.length} ready{blocked > 0 && <Tag type="gray" size="sm">{blocked} not ready</Tag>}</span></TableCell>
                <TableCell className="sales-num">{formatEur(group.total)}</TableCell>
                <TableCell className="mj-hide-narrow">{formatDate(group.oldestEnd)}</TableCell>
              </TableExpandRow>,
              open && (
                <TableExpandedRow key={`${group.customer.id}-jobs`} colSpan={canCreate ? 6 : 5}>
                  <ul className="sales-ready-jobs">
                    {group.rows.map(({ job, price, reason }) => {
                      const run = prints.find((print) => print.id === job.printId);
                      return (
                        <li key={job.id} className="sales-ready-jobs__row">
                          {canCreate && <Checkbox id={`ready-${job.id}`} labelText={`Select ${job.displayId}`} hideLabel disabled={!!reason} checked={selected.has(job.id)} onChange={() => setSelected((current) => toggle(current, job.id))} />}
                          <div className="mj-title-with-thumb">
                            <RunThumb run={run} />
                            <div className="mj-cell-stack">
                              <CarbonLink as={Link} to={`/jobs/${job.id}`}>{jobName(job, run)}</CarbonLink>
                              <span className="mj-secondary">{job.displayId} · {formatDateTimeRange(job.startsAt, job.endsAt)}</span>
                            </div>
                          </div>
                          <span className="mj-inline">{reason ? <Tag type="red" size="sm">{reason}</Tag> : <Tag type="green" size="sm">Ready</Tag>}<strong>{formatEur(price)}</strong></span>
                        </li>
                      );
                    })}
                  </ul>
                </TableExpandedRow>
              ),
            ];
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
