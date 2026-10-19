import { useMemo, useState } from 'react';
import { Checkbox, InlineNotification, Modal, Stack, Tag } from '@carbon/react';
import { formatDateTimeRange } from '../../../../app/dateTime';
import { RefLink } from '../../components/RefLink';
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
  const unavailable = others.map((job) => {
    const draft = job.order ? null : orderOfJob(job, store.orders)?.order ?? null;
    return {
      job, linked: job.order ? { id: job.order.orderId, reference: job.order.orderReference } : draft ? { id: draft.id, reference: draft.reference } : null,
      reason: job.order ? 'On order' : draft ? 'In draft' : jobBlocker(job, store.prints, now) ?? 'Not available',
    };
  });
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
                  <Checkbox id={`add-job-${job.id}`} labelText={`Select ${job.displayId}`} hideLabel
                    checked={selected.has(job.id)} onChange={(_event, { checked }) => setSelected((current) => { const next = new Set(current); if (checked) next.add(job.id); else next.delete(job.id); return next; })} />
                  <span className="mj-cell-stack sales-job-picker__text"><strong>{jobName(job, run)}</strong><span className="mj-secondary"><RefLink reference={job.displayId} id={job.id} onNavigate={onClose} /> · {formatDateTimeRange(job.startsAt, job.endsAt)} · {formatDuration(job.durationSeconds)}</span></span>
                  <strong>{formatEur(effectivePrice(job))}</strong>
                </div>
              );
            })}
          </fieldset>
        )}
        {unavailable.length > 0 && (
          <div>
            <p className="mj-secondary">Not available for this order:</p>
            <ul className="sales-reason-list">{unavailable.map(({ job, reason, linked }) => <li key={job.id}><span><RefLink reference={job.displayId} id={job.id} onNavigate={onClose} /> · {jobName(job, store.prints.find((print) => print.id === job.printId))}</span><span className="mj-inline"><Tag type="gray" size="sm">{reason}</Tag>{linked && <RefLink reference={linked.reference} id={linked.id} onNavigate={onClose} />}</span></li>)}</ul>
          </div>
        )}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not add" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
