import { useState } from 'react';
import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import { useNavigate } from 'react-router-dom';
import { effectivePrice, formatDateTime, jobName } from '../../derived';
import { useStore } from '../../store';
import type { Job } from '../../types';
import { formatEur } from '../format';
import { activeItems } from '../logic';
import { useSalesMutation } from '../useSalesMutation';

/** From the Jobs mass edit: puts finished jobs of one customer on an existing draft or on a new one. */
export function AddToOrderModal({ open, jobs, onClose, onDone }: { open: boolean; jobs: Job[]; onClose: () => void; onDone: () => void }) {
  const store = useStore();
  const navigate = useNavigate();
  const customer = jobs[0]?.customer ?? null;
  const drafts = store.orders.filter((order) => order.status === 'draft' && !order.replacesOrderId && order.customer?.id === customer?.id);
  const [target, setTarget] = useState<'new' | 'existing'>('new');
  const [draftId, setDraftId] = useState('');
  const chosen = target === 'existing' ? draftId || drafts[0]?.id : '';
  const { mutate, pending, error } = useSalesMutation(() => target === 'existing' && chosen
    ? (store.addOrderJobs(chosen, jobs.map((job) => job.id)), chosen)
    : store.createDraftFromJobs(customer!, jobs.map((job) => job.id)).orderId);

  if (!open || !customer) return null;
  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    const order = store.orders.find((item) => item.id === result.value);
    store.notify({ kind: 'success', title: `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'} added to ${order?.reference ?? 'the order'}`, subtitle: 'Review the draft, then finalize it.' });
    onDone();
    onClose();
    navigate(`/sales/orders/${result.value}`);
  };
  const total = jobs.reduce((sum, job) => sum + (effectivePrice(job) ?? 0), 0);

  return (
    <Modal
      open size="md" modalHeading="Add to order" modalLabel={customer.displayName} primaryButtonText={pending ? 'Adding…' : target === 'existing' ? 'Add to draft' : 'Create draft'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || (target === 'existing' && !chosen)} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={5}>
        <RadioButtonGroup legendText="Where should the jobs go?" name="add-to-order-target" orientation="vertical" valueSelected={target} onChange={(value) => setTarget(value as 'new' | 'existing')}>
          <RadioButton id="add-to-order-new" value="new" labelText="A new draft order" />
          <RadioButton id="add-to-order-existing" value="existing" labelText={drafts.length ? 'An open draft of this customer' : 'An open draft of this customer (none yet)'} disabled={drafts.length === 0} />
        </RadioButtonGroup>
        {target === 'existing' && drafts.length > 0 && (
          <Select id="add-to-order-draft" labelText="Draft" value={chosen} onChange={(event) => setDraftId(event.target.value)}>
            {drafts.map((draft) => <SelectItem key={draft.id} value={draft.id} text={`${draft.reference} · ${activeItems(draft).length} items`} />)}
          </Select>
        )}
        <StructuredListWrapper isCondensed aria-label="Jobs to add">
          <StructuredListHead><StructuredListRow head><StructuredListCell head>Job</StructuredListCell><StructuredListCell head>Finished</StructuredListCell><StructuredListCell head>Price</StructuredListCell></StructuredListRow></StructuredListHead>
          <StructuredListBody>
            {jobs.map((job) => <StructuredListRow key={job.id}><StructuredListCell>{job.displayId} · {jobName(job, store.prints.find((print) => print.id === job.printId))}</StructuredListCell><StructuredListCell>{formatDateTime(job.endsAt)}</StructuredListCell><StructuredListCell>{formatEur(effectivePrice(job))}</StructuredListCell></StructuredListRow>)}
            <StructuredListRow><StructuredListCell><strong>Total</strong></StructuredListCell><StructuredListCell /><StructuredListCell><strong>{formatEur(total)}</strong></StructuredListCell></StructuredListRow>
          </StructuredListBody>
        </StructuredListWrapper>
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not add" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
