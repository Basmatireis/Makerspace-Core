import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { ComboBox, InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack, Tag, TextInput } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { listMaterials } from '../../api/generated/inventory/inventory';
import { listMachineJobs } from '../../api/generated/machine-jobs/machine-jobs';
import { addOrderItem, createOrder, updateOrder, updateOrderItem } from '../../api/generated/orders/orders';
import type { BillingParty, Material, Order, OrderItem } from '../../api/generated/models';
import { useNotify } from '../machinelogbook/shared/toasts';
import { matchesName } from '../machinelogbook/dialogs/jobFormHelpers';
import { billingPartySearchQuery } from '../machinelogbook/queries';
import { formatMoney } from './formatting';
import { formatQuantity } from '../machinelogbook/shared/format';
import { formatCents, lineAmountCents, parseDecimalInput } from './money';
import { useFinanceMutation } from './queries';

type Fulfillment = 'immediate' | 'deferred';

/** Creates a draft (order = null) or edits the customer and hand-over of an existing draft. */
export function EditOrderModal({ order, onClose, onSaved }: { order: Order | null; onClose: () => void; onSaved: (orderId: string) => void }) {
  const notify = useNotify();
  const [search, setSearch] = useState('');
  const [customer, setCustomer] = useState<BillingParty | null>(() => order?.customer ? { kind: order.customer.kind, id: order.customer.id, displayName: order.customerName ?? 'Current customer', pricingGroupAssignmentVersion: 0 } : null);
  const [fulfillment, setFulfillment] = useState<Fulfillment>(order?.fulfillmentMode ?? 'immediate');
  const parties = useQuery({ ...billingPartySearchQuery(search), placeholderData: keepPreviousData });
  const items = [...new Map([...(customer ? [customer] : []), ...(parties.data?.items ?? [])].map((party) => [party.id, party])).values()];
  const mutation = useFinanceMutation(async () => {
    const target = customer ? { kind: customer.kind, id: customer.id } : null;
    if (order) { await updateOrder(order.id, { customer: target, fulfillmentMode: fulfillment, expectedVersion: order.version }); return order.id; }
    return (await createOrder({ customer: target, fulfillmentMode: fulfillment })).id;
  }, (id) => {
    if (order) notify({ kind: 'success', title: 'Order updated', subtitle: `${order.reference} is billed to ${customer?.displayName}.` });
    onSaved(id);
    onClose();
  });
  return (
    <Modal
      open size="sm" modalHeading={order ? 'Edit order' : 'New order'} modalLabel={order?.reference} primaryButtonText={mutation.isPending ? 'Saving…' : order ? 'Save' : 'Create draft'} secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending || !customer} preventCloseOnClickOutside onRequestClose={() => { if (!mutation.isPending) onClose(); }} onRequestSubmit={() => mutation.mutate()}
    >
      <Stack gap={6}>
        <ComboBox
          autoAlign id="order-customer" titleText="Customer" placeholder="Search people or organizations" items={items} itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName}
          selectedItem={customer} helperText="An account or an organization that pays this order." onInputChange={setSearch} onChange={({ selectedItem }) => setCustomer(selectedItem ?? null)}
        />
        <RadioButtonGroup legendText="Hand-over" name="order-fulfillment" orientation="vertical" valueSelected={fulfillment} onChange={(value) => setFulfillment(value as Fulfillment)}>
          <RadioButton id="order-fulfillment-immediate" value="immediate" labelText="Handed over now" />
          <RadioButton id="order-fulfillment-deferred" value="deferred" labelText="Customer picks it up later" />
        </RadioButtonGroup>
        {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save" subtitle={mutation.error.message} />}
      </Stack>
    </Modal>
  );
}

type ItemValues = { description: string; quantity: string; unit: string; unitPrice: string };

/** Adds a custom (manual) item to a draft, or edits one. */
export function CustomItemModal({ order, item, onClose }: { order: Order; item: OrderItem | null; onClose: () => void }) {
  const form = useForm<ItemValues>({ defaultValues: item ? { description: item.description, quantity: item.quantity, unit: item.unit, unitPrice: item.unitPrice } : { description: '', quantity: '1', unit: 'piece', unitPrice: '' } });
  const mutation = useFinanceMutation(async (values: ItemValues) => {
    const input = { kind: 'manual' as const, description: values.description.trim(), quantity: parseDecimalInput(values.quantity)!, unit: values.unit.trim(), unitPrice: parseDecimalInput(values.unitPrice)!, expectedVersion: order.version };
    return item ? updateOrderItem(order.id, item.id, input) : addOrderItem(order.id, input);
  }, onClose);
  const errors = form.formState.errors;
  const decimal = (message: string) => ({ required: 'Required', validate: (value: string) => parseDecimalInput(value) !== null || message });
  return (
    <Modal
      open size="sm" modalHeading={item ? 'Edit custom item' : 'Add custom item'} modalLabel={order.reference} primaryButtonText={mutation.isPending ? 'Saving…' : item ? 'Save item' : 'Add item'} secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending} preventCloseOnClickOutside onRequestClose={() => { if (!mutation.isPending) onClose(); }} onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <Stack gap={5}>
        <TextInput id="item-description" labelText="Description" invalid={!!errors.description} invalidText={errors.description?.message} {...form.register('description', { required: 'Required', validate: (value) => value.trim() !== '' || 'Required' })} />
        <TextInput id="item-quantity" labelText="Quantity" inputMode="decimal" invalid={!!errors.quantity} invalidText={errors.quantity?.message} {...form.register('quantity', decimal('Use a number, e.g. 2 or 1.5'))} />
        <TextInput id="item-unit" labelText="Unit" invalid={!!errors.unit} invalidText={errors.unit?.message} {...form.register('unit', { required: 'Required' })} />
        <TextInput id="item-unit-price" labelText="Unit price (€)" inputMode="decimal" invalid={!!errors.unitPrice} invalidText={errors.unitPrice?.message} {...form.register('unitPrice', decimal('Use a decimal amount, e.g. 4.50'))} />
        {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save" subtitle={mutation.error.message} />}
      </Stack>
    </Modal>
  );
}

/** Adds a finished job of the order's customer. */
export function AddJobsModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<{ id: string; version: number } | null>(null);
  const jobs = useQuery({
    queryKey: ['orders', 'eligible-jobs', order.customer?.id, search],
    queryFn: () => listMachineJobs({ search, customerId: order.customer?.id, page: 1, pageSize: 25 }),
    placeholderData: keepPreviousData,
  });
  const mutation = useFinanceMutation(() => addOrderItem(order.id, { kind: 'machine_job', machineJobId: selected!.id, expectedJobVersion: selected!.version, expectedVersion: order.version }), onClose);
  return (
    <Modal
      open size="sm" modalHeading="Add a job" modalLabel={order.reference} primaryButtonText={mutation.isPending ? 'Adding…' : 'Add job'} secondaryButtonText="Cancel" primaryButtonDisabled={!selected || mutation.isPending}
      preventCloseOnClickOutside onRequestClose={() => { if (!mutation.isPending) onClose(); }} onRequestSubmit={() => mutation.mutate()}
    >
      <Stack gap={5}>
        <p>The job is added with its price as of now. Prices freeze when the order is finalized.</p>
        <ComboBox
          autoAlign id="order-job" titleText="Job" placeholder="Search jobs of this customer" items={jobs.data?.items ?? []} onInputChange={setSearch}
          itemToString={(job) => job ? `${job.displayId} · ${job.machine.name} · ${formatMoney(job.effectivePrice)}` : ''} shouldFilterItem={() => true}
          onChange={({ selectedItem }) => setSelected(selectedItem ? { id: selectedItem.id, version: selectedItem.version } : null)}
        />
        {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not add the job" subtitle={mutation.error.message} />}
      </Stack>
    </Modal>
  );
}

type StockValues = { quantity: string; unitPrice: string };

const kindText: Record<Material['kind'], string> = { filament: 'Filament', consumable: 'Consumable', part: 'Part' };

/** Sells an inventory article from stock: adds an inventory item to a draft, or edits quantity and price of one. */
export function InventoryItemModal({ order, item, onClose }: { order: Order; item: OrderItem | null; onClose: () => void }) {
  const [search, setSearch] = useState('');
  const [article, setArticle] = useState<Material | null>(null);
  const form = useForm<StockValues>({ defaultValues: item ? { quantity: item.quantity, unitPrice: item.unitPrice } : { quantity: '1', unitPrice: '' } });
  const editing = item !== null;
  const articles = useQuery({
    queryKey: ['orders', 'stock-articles', search],
    queryFn: () => listMaterials({ search, page: 1, pageSize: 25 }),
    placeholderData: keepPreviousData,
    enabled: !editing,
  });
  const choices = (articles.data?.items ?? []).filter((candidate) => candidate.active);
  const mutation = useFinanceMutation(async (values: StockValues) => {
    const input = { kind: 'inventory_item' as const, materialId: (item ? item.sourceMaterialId : article?.id) ?? undefined, quantity: parseDecimalInput(values.quantity)!, unitPrice: parseDecimalInput(values.unitPrice)!, expectedVersion: order.version };
    return item ? updateOrderItem(order.id, item.id, input) : addOrderItem(order.id, input);
  }, onClose);

  const errors = form.formState.errors;
  const [quantityText, priceText] = form.watch(['quantity', 'unitPrice']);
  const quantity = parseDecimalInput(quantityText);
  const price = parseDecimalInput(priceText);
  const unit = item?.unit ?? article?.unit ?? '';
  const amount = quantity !== null && price !== null ? lineAmountCents(quantity, price) : null;
  const short = !editing && article && quantity !== null && Number(quantity) > Number(article.unassignedQuantity);
  const selectArticle = (selected: Material | null) => {
    setArticle(selected);
    form.setValue('unitPrice', selected?.salePrice ?? '', { shouldValidate: form.formState.isSubmitted });
  };
  const decimal = (message: string) => ({ required: 'Required', validate: (value: string) => parseDecimalInput(value) !== null || message });
  return (
    <Modal
      open size="sm" modalHeading={editing ? 'Edit stock item' : 'Add from inventory'} modalLabel={order.reference} primaryButtonText={mutation.isPending ? 'Saving…' : editing ? 'Save item' : 'Add item'} secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending || (!editing && !article)} preventCloseOnClickOutside onRequestClose={() => { if (!mutation.isPending) onClose(); }} onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <Stack gap={5}>
        {item ? <p><strong>{item.description}</strong></p> : (
          <ComboBox
            autoAlign id="order-article" titleText="Article" placeholder="Search articles" items={choices} selectedItem={article} onInputChange={setSearch} shouldFilterItem={() => true}
            itemToString={(candidate) => candidate?.name ?? ''}
            itemToElement={(candidate) => candidate ? (
              <span className="mj-cell-stack">
                <span>{candidate.name} <Tag type="outline" size="sm">{kindText[candidate.kind]}</Tag></span>
                <span className="mj-secondary">{formatQuantity(candidate.unassignedQuantity, 6)} {candidate.unit} in stock · {candidate.salePrice ? `${formatMoney(candidate.salePrice)} per ${candidate.unit}` : 'no sale price'}</span>
              </span>
            ) : null}
            onChange={({ selectedItem }) => selectArticle(selectedItem ?? null)}
          />
        )}
        <TextInput
          id="stock-quantity" labelText={unit ? `Quantity (${unit})` : 'Quantity'} inputMode="decimal" invalid={!!errors.quantity} invalidText={errors.quantity?.message}
          {...form.register('quantity', { required: 'Required', validate: (value) => { const parsed = parseDecimalInput(value); return parsed === null ? 'Use a number, e.g. 2 or 1.5' : Number(parsed) > 0 || 'Must be more than zero'; } })}
        />
        {short && <InlineNotification kind="warning" lowContrast hideCloseButton title="Low stock" subtitle={`Only ${formatQuantity(article.unassignedQuantity, 6)} ${article.unit} in loose stock — finalizing will fail until stock is received.`} />}
        <TextInput
          id="stock-unit-price" labelText="Unit price (€)" inputMode="decimal" invalid={!!errors.unitPrice} invalidText={errors.unitPrice?.message}
          helperText={article && !article.salePrice ? 'This article has no sale price. Enter the price.' : undefined}
          {...form.register('unitPrice', decimal('Use a decimal amount, e.g. 4.50'))}
        />
        <p>Amount: <strong>{amount === null ? '—' : formatCents(amount)}</strong></p>
        {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not save" subtitle={mutation.error.message} />}
      </Stack>
    </Modal>
  );
}
