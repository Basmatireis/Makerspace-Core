import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack, TextInput } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { addOrderItem, createOrder, updateOrder, updateOrderItem } from '../../api/generated/orders/orders';
import type { BillingParty, Order, OrderItem, WorkItem } from '../../api/generated/models';
import { FuzzyComboBox } from '../../app/components/FuzzyComboBox';
import { useNotify } from '../machinelogbook/shared/toasts';
import { billingPartySearchQuery } from '../machinelogbook/queries';
import { formatMoney } from './formatting';
import { jobLabel } from './logic';
import { parseDecimalInput } from './money';
import { customerJobsQuery, useFinanceMutation } from './queries';

type Fulfillment = 'immediate' | 'deferred';

/** Creates a draft (order = null) or edits the customer and hand-over of an existing draft. */
export function EditOrderModal({
  order,
  onClose,
  onSaved,
}: {
  order: Order | null;
  onClose: () => void;
  onSaved: (orderId: string) => void;
}) {
  const notify = useNotify();
  const [search, setSearch] = useState('');
  const [customer, setCustomer] = useState<BillingParty | null>(() =>
    order?.customer
      ? {
          kind: order.customer.kind,
          id: order.customer.id,
          displayName: order.customerName ?? 'Current customer',
          pricingGroupAssignmentVersion: 0,
        }
      : null,
  );
  const [fulfillment, setFulfillment] = useState<Fulfillment>(order?.fulfillmentMode ?? 'immediate');
  const parties = useQuery({ ...billingPartySearchQuery(search), placeholderData: keepPreviousData });
  const items = [
    ...new Map(
      [...(customer ? [customer] : []), ...(parties.data?.items ?? [])].map((party) => [party.id, party]),
    ).values(),
  ];
  const mutation = useFinanceMutation(
    async () => {
      const target = customer ? { kind: customer.kind, id: customer.id } : null;
      if (order) {
        await updateOrder(order.id, { customer: target, fulfillmentMode: fulfillment, expectedVersion: order.version });
        return order.id;
      }
      return (await createOrder({ customer: target, fulfillmentMode: fulfillment })).id;
    },
    (id) => {
      if (order)
        notify({
          kind: 'success',
          title: 'Order updated',
          subtitle: `${order.reference} is billed to ${customer?.displayName}.`,
        });
      onSaved(id);
      onClose();
    },
  );
  return (
    <Modal
      open
      size="sm"
      modalHeading={order ? 'Edit order' : 'New order'}
      modalLabel={order?.reference}
      primaryButtonText={mutation.isPending ? 'Saving…' : order ? 'Save' : 'Create draft'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending || !customer}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => mutation.mutate()}
    >
      <Stack gap={6}>
        <FuzzyComboBox<BillingParty>
          autoAlign
          id="order-customer"
          titleText="Customer"
          placeholder="Search people or organizations"
          items={items}
          itemToString={(item) => item?.displayName ?? ''}
          selectedItem={customer}
          helperText="Every customer has an account or is an organization; there are no anonymous sales."
          onInputChange={setSearch}
          onChange={({ selectedItem }) => setCustomer(selectedItem ?? null)}
        />
        <RadioButtonGroup
          legendText="Hand-over"
          name="order-fulfillment"
          orientation="vertical"
          valueSelected={fulfillment}
          onChange={(value) => setFulfillment(value as Fulfillment)}
        >
          <RadioButton id="order-fulfillment-immediate" value="immediate" labelText="Handed over now" />
          <RadioButton id="order-fulfillment-deferred" value="deferred" labelText="Customer picks it up later" />
        </RadioButtonGroup>
        {mutation.error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Could not save"
            subtitle={mutation.error.message}
          />
        )}
      </Stack>
    </Modal>
  );
}

type ItemValues = { description: string; quantity: string; unit: string; unitPrice: string };

/** Adds a custom (manual) item to a draft, or edits one. */
export function CustomItemModal({
  order,
  item,
  onClose,
}: {
  order: Order;
  item: OrderItem | null;
  onClose: () => void;
}) {
  const form = useForm<ItemValues>({
    defaultValues: item
      ? { description: item.description, quantity: item.quantity, unit: item.unit, unitPrice: item.unitPrice }
      : { description: '', quantity: '1', unit: 'piece', unitPrice: '' },
  });
  const mutation = useFinanceMutation(async (values: ItemValues) => {
    const input = {
      kind: 'manual' as const,
      description: values.description.trim(),
      quantity: parseDecimalInput(values.quantity)!,
      unit: values.unit.trim(),
      unitPrice: parseDecimalInput(values.unitPrice)!,
      expectedVersion: order.version,
    };
    return item ? updateOrderItem(order.id, item.id, input) : addOrderItem(order.id, input);
  }, onClose);
  const errors = form.formState.errors;
  const decimal = (message: string) => ({
    required: 'Required',
    validate: (value: string) => parseDecimalInput(value) !== null || message,
  });
  return (
    <Modal
      open
      size="sm"
      modalHeading={item ? 'Edit custom item' : 'Add custom item'}
      modalLabel={order.reference}
      primaryButtonText={mutation.isPending ? 'Saving…' : item ? 'Save item' : 'Add item'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <Stack gap={5}>
        <TextInput
          id="item-description"
          labelText="Description"
          placeholder="For example Workshop fee"
          invalid={!!errors.description}
          invalidText={errors.description?.message}
          {...form.register('description', {
            required: 'Required',
            validate: (value) => value.trim() !== '' || 'Required',
          })}
        />
        <TextInput
          id="item-quantity"
          labelText="Quantity"
          inputMode="decimal"
          invalid={!!errors.quantity}
          invalidText={errors.quantity?.message}
          {...form.register('quantity', decimal('Use a number, e.g. 2 or 1.5'))}
        />
        <TextInput
          id="item-unit"
          labelText="Unit"
          invalid={!!errors.unit}
          invalidText={errors.unit?.message}
          {...form.register('unit', { required: 'Required' })}
        />
        <TextInput
          id="item-unit-price"
          labelText="Unit price (€)"
          inputMode="decimal"
          invalid={!!errors.unitPrice}
          invalidText={errors.unitPrice?.message}
          {...form.register('unitPrice', decimal('Use a decimal amount, e.g. 4.50'))}
        />
        {mutation.error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Could not save"
            subtitle={mutation.error.message}
          />
        )}
      </Stack>
    </Modal>
  );
}

/** Adds a finished job of the order's customer that is on no order yet. */
export function AddJobsModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const jobs = useQuery({ ...customerJobsQuery(order.customer?.id ?? ''), enabled: !!order.customer });
  const mutation = useFinanceMutation(
    () =>
      addOrderItem(order.id, {
        kind: 'machine_job',
        machineJobId: selected!.id,
        expectedJobVersion: selected!.version,
        expectedVersion: order.version,
      }),
    onClose,
  );
  const choices = jobs.data ?? [];
  return (
    <Modal
      open
      size="sm"
      modalHeading="Add a job"
      modalLabel={order.reference}
      primaryButtonText={mutation.isPending ? 'Adding…' : 'Add job'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!selected || mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => mutation.mutate()}
    >
      <Stack gap={5}>
        <p>The job is added with its price as of now. Prices freeze when the order is finalized.</p>
        <FuzzyComboBox<WorkItem>
          autoAlign
          id="order-job"
          titleText="Job"
          placeholder={jobs.isPending && !!order.customer ? 'Loading jobs…' : 'Search jobs of this customer'}
          items={choices}
          selectedItem={selected}
          itemToString={jobLabel}
          itemToElement={(job) =>
            job ? (
              <span className="sales-option">
                <span>{jobLabel(job)}</span>
                <span className="sales-secondary">
                  {job.effectivePrice ? formatMoney(job.effectivePrice) : 'Price incomplete'}
                </span>
              </span>
            ) : null
          }
          helperText={
            jobs.isSuccess && choices.length === 0
              ? `${order.customerName ?? 'This customer'} has no finished job that is not on an order.`
              : 'Finished jobs of this customer that are on no order yet.'
          }
          invalid={jobs.isError}
          invalidText="The jobs could not be loaded."
          onChange={({ selectedItem }) => setSelected(selectedItem ?? null)}
        />
        {mutation.error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Could not add the job"
            subtitle={mutation.error.message}
          />
        )}
      </Stack>
    </Modal>
  );
}
