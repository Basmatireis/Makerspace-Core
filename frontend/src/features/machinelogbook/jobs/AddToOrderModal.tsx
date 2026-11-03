import { useState } from 'react';
import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { MachineJob } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { formatMoney } from '../shared/format';
import { machineJobName } from '../shared/status';
import { useNotify } from '../shared/toasts';
import { draftOrdersQuery, useAddJobToOrder } from './jobsQueries';
import '../styles/jobs.scss';
import './jobs.scss';

function AddToOrderForm({ job, onClose }: { job: MachineJob; onClose: () => void }) {
  const notify = useNotify();
  const navigate = useNavigate();
  const drafts = useQuery(draftOrdersQuery(job.customer));
  const orders = drafts.data ?? [];
  const [chosenMode, setMode] = useState<'existing' | 'new' | null>(null);
  const mode = chosenMode ?? (orders.length > 0 ? 'existing' : 'new');
  const [orderId, setOrderId] = useState<string | null>(null);
  const order = orders.find((item) => item.id === (orderId ?? orders[0]?.id)) ?? null;
  const [handover, setHandover] = useState<'deferred' | 'immediate'>('deferred');
  const add = useAddJobToOrder(job);
  const recipient = job.customer?.displayName ?? 'the recipient';
  const failure =
    add.error instanceof ApiError && add.error.data?.message
      ? add.error.data.message
      : add.error instanceof Error
        ? add.error.message
        : 'The job could not be added to the order.';
  return (
    <Modal
      open
      size="sm"
      modalHeading="Add to order"
      modalLabel={`${job.displayId} · ${machineJobName(job)}`}
      primaryButtonText={add.isPending ? 'Saving…' : mode === 'new' ? 'Create order' : 'Add to order'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={add.isPending || drafts.isPending || (mode === 'existing' && !order)}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!add.isPending) onClose();
      }}
      onRequestSubmit={() =>
        add.mutate(
          { order: mode === 'existing' ? order : null, fulfillmentMode: handover },
          {
            onSuccess: (saved) => {
              notify({
                kind: 'success',
                title: mode === 'existing' ? 'Added to order' : 'Order created',
                subtitle: `${job.displayId} → ${saved.reference}`,
              });
              onClose();
              navigate(`/orders/${saved.id}`);
            },
          },
        )
      }
    >
      <Stack gap={5}>
        {add.isError && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Not added" subtitle={failure} />
        )}
        {drafts.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Orders could not be loaded"
            subtitle="A new draft order can still be created."
          />
        )}
        <dl className="jobs-summary">
          <div>
            <dt>Job</dt>
            <dd>
              {machineJobName(job)} · {formatMoney(job.effectivePrice)}
            </dd>
          </div>
          <div>
            <dt>Recipient</dt>
            <dd>{recipient}</dd>
          </div>
        </dl>
        <RadioButtonGroup
          name="add-to-order-mode"
          legendText="Which order?"
          orientation="vertical"
          valueSelected={mode}
          onChange={(value) => setMode(value as 'existing' | 'new')}
        >
          <RadioButton
            id="add-to-order-existing"
            value="existing"
            disabled={orders.length === 0}
            labelText={`Draft order of ${recipient}`}
          />
          <RadioButton id="add-to-order-new" value="new" labelText="New order" />
        </RadioButtonGroup>
        {mode === 'existing' ? (
          <FuzzySelectField
            id="add-to-order-order"
            titleText="Order"
            placeholder="Select an order"
            options={orders.map((item) => ({
              id: item.id,
              label: `${item.reference} · ${item.items.length} ${item.items.length === 1 ? 'item' : 'items'} · ${formatMoney(item.totalAmount)}`,
            }))}
            value={order?.id ?? null}
            onChange={setOrderId}
          />
        ) : (
          <RadioButtonGroup
            name="add-to-order-handover"
            legendText="Hand-over"
            orientation="vertical"
            valueSelected={handover}
            onChange={(value) => setHandover(value as 'deferred' | 'immediate')}
          >
            <RadioButton id="add-to-order-later" value="deferred" labelText="Later: pick up or ship when it is paid" />
            <RadioButton id="add-to-order-now" value="immediate" labelText="Now: the recipient takes it today" />
          </RadioButtonGroup>
        )}
        <p className="mj-secondary">
          {mode === 'existing'
            ? `${orders.length} draft ${orders.length === 1 ? 'order' : 'orders'} of ${recipient}.`
            : 'A draft order with this job as its first item.'}
        </p>
      </Stack>
    </Modal>
  );
}

/** Puts a finished job on its recipient's draft order, or on a new draft order, then opens the order. */
export function AddToOrderModal({ open, job, onClose }: { open: boolean; job: MachineJob; onClose: () => void }) {
  return open ? <AddToOrderForm job={job} onClose={onClose} /> : null;
}
