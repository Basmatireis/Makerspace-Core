import { useState } from 'react';
import { ComboBox, InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack } from '@carbon/react';
import { matchesName } from '../../dialogs/jobFormHelpers';
import { lookups, useStore } from '../../store';
import type { BillingParty } from '../../types';
import { useSalesMutation } from '../useSalesMutation';
import type { FulfillmentMode, Order } from '../types';

/** Creates a draft (order = null) or edits the customer and hand-over of an existing draft. */
export function EditOrderModal({ order, initialCustomer, onClose, onSaved }: { order: Order | null; initialCustomer?: BillingParty | null; onClose: () => void; onSaved: (orderId: string) => void }) {
  const store = useStore();
  const [customer, setCustomer] = useState<BillingParty | null>(() => order?.customer ? lookups.people.find((party) => party.id === order.customer!.id) ?? null : initialCustomer ?? null);
  const [fulfillment, setFulfillment] = useState<FulfillmentMode>(order?.fulfillmentMode ?? 'immediate');
  const effective: FulfillmentMode = customer ? fulfillment : 'immediate';
  const { mutate, pending, error } = useSalesMutation(() => order
    ? (store.updateDraftOrder(order.id, { customer, fulfillmentMode: effective }), order.id)
    : store.createDraftOrder({ customer, fulfillmentMode: effective }).orderId);

  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    if (order) store.notify({ kind: 'success', title: 'Order updated', subtitle: customer ? `${order.reference} is billed to ${customer.displayName}.` : `${order.reference} is a walk-in order.` });
    onSaved(result.value);
    onClose();
  };

  return (
    <Modal
      open size="sm" modalHeading={order ? 'Edit order' : 'New order'} modalLabel={order?.reference} primaryButtonText={pending ? 'Saving…' : order ? 'Save' : 'Create draft'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={6}>
        <ComboBox
          autoAlign id="order-customer" titleText="Customer" placeholder="Walk-in customer (no name)" items={lookups.people} itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName}
          selectedItem={customer} helperText="A person or organization that pays this order. Leave empty for a walk-in sale." onChange={({ selectedItem }) => setCustomer(selectedItem ?? null)}
        />
        <RadioButtonGroup legendText="Hand-over" name="order-fulfillment" orientation="vertical" valueSelected={effective} onChange={(value) => setFulfillment(value as FulfillmentMode)}>
          <RadioButton id="order-fulfillment-immediate" value="immediate" labelText="Handed over now" />
          <RadioButton id="order-fulfillment-deferred" value="deferred" labelText="Customer picks it up later" disabled={!customer} />
        </RadioButtonGroup>
        {!customer && <p className="mj-secondary">Walk-in orders are handed over immediately and must be paid in full when they are checked out.</p>}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
