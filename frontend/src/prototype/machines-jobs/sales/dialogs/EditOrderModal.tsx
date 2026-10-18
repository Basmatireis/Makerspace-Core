import { useState } from 'react';
import { ComboBox, InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack } from '@carbon/react';
import { matchesName } from '../../dialogs/jobFormHelpers';
import { lookups, useStore } from '../../store';
import type { BillingParty } from '../../types';
import { resolveGroup } from '../pricing';
import { useSalesMutation } from '../useSalesMutation';
import type { FulfillmentMode, Order } from '../types';

/** Creates a draft (order = null) or edits the customer and hand-over of an existing draft. Every order has a customer. */
export function EditOrderModal({ order, initialCustomer, onClose, onSaved }: { order: Order | null; initialCustomer?: BillingParty | null; onClose: () => void; onSaved: (orderId: string) => void }) {
  const store = useStore();
  const [customer, setCustomer] = useState<BillingParty | null>(() => order ? lookups.people.find((party) => party.id === order.customer.id) ?? null : initialCustomer ?? null);
  const [fulfillment, setFulfillment] = useState<FulfillmentMode>(order?.fulfillmentMode ?? 'immediate');
  const resolved = customer ? resolveGroup(store.pricing, store.organizations, customer) : null;
  const { mutate, pending, error } = useSalesMutation(() => order
    ? (store.updateDraftOrder(order.id, { customer, fulfillmentMode: fulfillment }), order.id)
    : store.createDraftOrder({ customer, fulfillmentMode: fulfillment }).orderId);

  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    if (order) store.notify({ kind: 'success', title: 'Order updated', subtitle: `${order.reference} is billed to ${customer!.displayName}.` });
    onSaved(result.value);
    onClose();
  };

  return (
    <Modal
      open size="sm" modalHeading={order ? 'Edit order' : 'New order'} modalLabel={order?.reference} primaryButtonText={pending ? 'Saving…' : order ? 'Save' : 'Create draft'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || !customer} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={6}>
        <ComboBox
          autoAlign id="order-customer" titleText="Customer" placeholder="Search people or organizations" items={lookups.people} itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName}
          selectedItem={customer} helperText={resolved ? `Priced with ${resolved.group.name} (${resolved.reason}).` : 'An account or an organization that pays this order.'} onChange={({ selectedItem }) => setCustomer(selectedItem ?? null)}
        />
        <RadioButtonGroup legendText="Hand-over" name="order-fulfillment" orientation="vertical" valueSelected={fulfillment} onChange={(value) => setFulfillment(value as FulfillmentMode)}>
          <RadioButton id="order-fulfillment-immediate" value="immediate" labelText="Handed over now" />
          <RadioButton id="order-fulfillment-deferred" value="deferred" labelText="Customer picks it up later" />
        </RadioButtonGroup>
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
