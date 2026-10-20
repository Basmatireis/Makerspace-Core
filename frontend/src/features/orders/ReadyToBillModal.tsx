import { useState } from 'react';
import {
  Button, Checkbox, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, Table, TableBody, TableCell, TableContainer, TableExpandHeader, TableExpandRow, TableExpandedRow,
  TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, TableToolbarSearch, Tag,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { addOrderItem, createOrder } from '../../api/generated/orders/orders';
import { EmptyState, ErrorState, InlineLoadingState } from '../../app/PageState';
import { RefLink } from '../../app/RefLink';
import { formatDate, formatDateTimeRange } from '../../app/dateTime';
import { useNotify } from '../machinelogbook/shared/toasts';
import { workItemName } from '../machinelogbook/shared/status';
import { customerKindLabel } from './labels';
import { readyToBillGroups } from './logic';
import { formatCents } from './money';
import { readyToBillQuery, useFinanceMutation } from './queries';

/** Finished jobs without an order, grouped by customer. Creates one draft order per selected customer. */
export function ReadyToBillModal({ canCreate, onClose }: { canCreate: boolean; onClose: () => void }) {
  const notify = useNotify();
  const navigate = useNavigate();
  const query = useQuery(readyToBillQuery());
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const groups = readyToBillGroups(query.data ?? []);
  const visible = groups.filter((group) => !search || `${group.customer?.displayName ?? ''} ${group.rows.map((row) => workItemName(row.job)).join(' ')}`.toLowerCase().includes(search.toLowerCase()));
  const toggle = (set: Set<string>, id: string) => { const next = new Set(set); if (!next.delete(id)) next.add(id); return next; };
  const selectedGroups = groups.filter((group) => group.ready.some((row) => selected.has(row.job.id)));

  const create = useFinanceMutation(async () => {
    const created: string[] = [];
    for (const group of selectedGroups) {
      let order = await createOrder({ customer: { kind: group.customer!.kind, id: group.customer!.id }, fulfillmentMode: 'deferred' });
      created.push(order.id);
      for (const row of group.ready.filter((item) => selected.has(item.job.id))) {
        order = await addOrderItem(order.id, { kind: 'machine_job', machineJobId: row.job.id, expectedJobVersion: row.job.version!, expectedVersion: order.version });
      }
    }
    return created;
  }, (created) => {
    notify({ kind: 'success', title: `${created.length} draft ${created.length === 1 ? 'order' : 'orders'} created`, subtitle: `${selected.size} ${selected.size === 1 ? 'job' : 'jobs'} added. Review and finalize ${created.length === 1 ? 'it' : 'them'}.` });
    onClose();
    if (created.length === 1) navigate(`/orders/${created[0]}`);
  });

  return (
    <ComposedModal open size="lg" preventCloseOnClickOutside aria-label="Jobs ready to bill" onClose={() => { onClose(); return false; }}>
      <ModalHeader title="Jobs ready to bill" label="Orders" />
      <ModalBody hasScrollingContent>
        <p className="mj-secondary sales-top-gap">Finished jobs without an order, per customer. Select the jobs to put on one draft order per customer.</p>
        {query.isPending && <InlineLoadingState label="Loading jobs" />}
        {query.isError && <ErrorState message="The jobs could not be loaded." onRetry={() => query.refetch()} />}
        {query.data && groups.length === 0 && <EmptyState title="Nothing to bill" description="Finished jobs with a customer show up here until they are on an order." />}
        {query.data && groups.length > 0 && (
          <TableContainer className="mj-table-container">
            <TableToolbar aria-label="Ready to bill toolbar">
              <TableToolbarContent>
                <TableToolbarSearch id="ready-search" labelText="Search customers and jobs" placeholder="Search customers and jobs" onChange={(_event, value) => setSearch(value ?? '')} onClear={() => setSearch('')} />
              </TableToolbarContent>
            </TableToolbar>
            {create.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not create the orders" subtitle={create.error.message} />}
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
                  const open = expanded.has(group.key);
                  const chosen = group.ready.filter((row) => selected.has(row.job.id)).length;
                  const blocked = group.rows.length - group.ready.length;
                  const name = group.customer?.displayName ?? 'No customer';
                  return [
                    <TableExpandRow key={group.key} isExpanded={open} aria-label={`Show the jobs of ${name}`} onExpand={() => setExpanded((current) => toggle(current, group.key))}>
                      {canCreate && (
                        <TableCell>
                          <Checkbox id={`ready-group-${group.key}`} labelText={`Select all ready jobs of ${name}`} hideLabel disabled={group.ready.length === 0}
                            checked={chosen > 0 && chosen === group.ready.length} indeterminate={chosen > 0 && chosen < group.ready.length}
                            onChange={(_event, { checked }) => setSelected((current) => { const next = new Set(current); group.ready.forEach((row) => checked ? next.add(row.job.id) : next.delete(row.job.id)); return next; })} />
                        </TableCell>
                      )}
                      <TableCell><div className="mj-cell-stack"><strong>{name}</strong>{group.customer && <span className="mj-secondary">{customerKindLabel(group.customer.kind)}{group.customer.pricingGroup ? ` · ${group.customer.pricingGroup.name} prices` : ''}</span>}</div></TableCell>
                      <TableCell><span className="mj-inline">{group.ready.length} ready{blocked > 0 && <Tag type="gray" size="sm">{blocked} not ready</Tag>}</span></TableCell>
                      <TableCell className="sales-num">{formatCents(group.total)}</TableCell>
                      <TableCell className="mj-hide-narrow">{formatDate(group.oldestEnd)}</TableCell>
                    </TableExpandRow>,
                    open && (
                      <TableExpandedRow key={`${group.key}-jobs`} colSpan={canCreate ? 6 : 5}>
                        <ul className="sales-ready-jobs">
                          {group.rows.map(({ job, price, reason }) => (
                            <li key={job.id} className="sales-ready-jobs__row">
                              {canCreate && <Checkbox id={`ready-${job.id}`} labelText={`Select ${job.displayId}`} hideLabel disabled={!!reason} checked={selected.has(job.id)} onChange={() => setSelected((current) => toggle(current, job.id))} />}
                              <div className="mj-cell-stack">
                                <RefLink reference={job.displayId} id={job.id} kind="job" onNavigate={onClose}>{workItemName(job)}</RefLink>
                                <span className="mj-secondary">{job.displayId} · {job.endsAt ? formatDateTimeRange(job.startedAt, job.endsAt) : formatDate(job.startedAt)}</span>
                              </div>
                              <span className="mj-inline">{reason ? <Tag type="red" size="sm">{reason}</Tag> : <Tag type="green" size="sm">Ready</Tag>}<strong>{price == null ? '—' : formatCents(price)}</strong></span>
                            </li>
                          ))}
                        </ul>
                      </TableExpandedRow>
                    ),
                  ];
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>Close</Button>
        {canCreate && <Button kind="primary" renderIcon={Add} disabled={selected.size === 0 || create.isPending} onClick={() => create.mutate()}>{selected.size ? `Create ${selectedGroups.length} ${selectedGroups.length === 1 ? 'order' : 'orders'} (${selected.size} ${selected.size === 1 ? 'job' : 'jobs'})` : 'Create order'}</Button>}
      </ModalFooter>
    </ComposedModal>
  );
}
