import { useMemo, useState } from 'react';
import { Checkbox, InlineNotification, Modal, Stack, Tag } from '@carbon/react';
import { formatDateTimeRange } from '../../../../app/dateTime';
import { effectivePrice, formatDuration, jobName } from '../../derived';
import { useNow, useStore } from '../../store';
import { formatEur } from '../format';
import { eligibleJobs, jobBlocker, orderOfJob, type OrderView } from '../logic';
import { useSalesMutation } from '../useSalesMutation';

/** Only jobs that can really be added are offered: this customer's finished, priced jobs that are on no order. The rest is explained, not listed as choices. */
export function AddJobsModal({ order, onClose }: { order: OrderView; onClose: () => void }) {
  const store = useStore();
  const now = useNow();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const eligible = useMemo(() => eligibleJobs(order, store.jobs, store.orders, store.prints, now), [order, store.jobs, store.orders, store.prints, now]);
  const others = store.jobs.filter((job) => job.customer?.id === order.customer?.id && !eligible.some((item) => item.id === job.id)
    && !order.items.some((item) => item.removedAt === null && item.sourceJobId === job.id));
  const unavailable = others.map((job) => ({ job, reason: job.order ? `On order ${job.order.orderReference}` : orderOfJob(job, store.orders)?.order ? `In draft ${orderOfJob(job, store.orders)!.order.reference}` : jobBlocker(job, store.prints, now) ?? 'Not available' }));
  const { mutate, pending, error } = useSalesMutation(() => store.addOrderJobs(order.id, [...selected]));

  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: `${selected.size} ${selected.size === 1 ? 'job' : 'jobs'} added`, subtitle: `They are priced as they are now; refresh them if a job changes.` });
    onClose();
  };
  const total = eligible.filter((job) => selected.has(job.id)).reduce((sum, job) => sum + (effectivePrice(job) ?? 0), 0);

  return (
    <Modal
      open size="md" modalHeading="Add jobs" modalLabel={`${order.reference} · ${order.customerLabel}`} primaryButtonText={pending ? 'Adding…' : selected.size ? `Add ${selected.size} ${selected.size === 1 ? 'job' : 'jobs'} · ${formatEur(total)}` : 'Add jobs'}
      secondaryButtonText="Cancel" primaryButtonDisabled={selected.size === 0 || pending} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={5}>
        {eligible.length === 0 ? <InlineNotification kind="info" lowContrast hideCloseButton title="No job can be added" subtitle={`${order.customerLabel} has no finished, priced job without an order.`} /> : (
          <fieldset className="sales-job-picker">
            <legend className="cds--label">Finished jobs of {order.customerLabel} without an order</legend>
            {eligible.map((job) => {
              const run = store.prints.find((print) => print.id === job.printId);
              return (
                <div key={job.id} className="sales-job-picker__row">
                  <Checkbox id={`add-job-${job.id}`} labelText={<span className="mj-title-with-thumb"><span className="mj-cell-stack"><strong>{jobName(job, run)}</strong><span className="mj-secondary">{job.displayId} · {formatDateTimeRange(job.startsAt, job.endsAt)} · {formatDuration(job.durationSeconds)}</span></span></span>}
                    checked={selected.has(job.id)} onChange={(_event, { checked }) => setSelected((current) => { const next = new Set(current); if (checked) next.add(job.id); else next.delete(job.id); return next; })} />
                  <strong>{formatEur(effectivePrice(job))}</strong>
                </div>
              );
            })}
          </fieldset>
        )}
        {unavailable.length > 0 && (
          <div>
            <p className="mj-secondary">Not available for this order:</p>
            <ul className="sales-reason-list">{unavailable.map(({ job, reason }) => <li key={job.id}><span>{job.displayId} · {jobName(job, store.prints.find((print) => print.id === job.printId))}</span><Tag type="gray" size="sm">{reason}</Tag></li>)}</ul>
          </div>
        )}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not add" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
