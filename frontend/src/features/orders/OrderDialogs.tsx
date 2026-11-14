import { useState, type MouseEvent } from 'react';
import { useForm } from 'react-hook-form';
import {
  DataTable,
  InlineNotification,
  Modal,
  Search,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableSelectRow,
  TextInput,
} from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { addOrderItem, createOrder, updateOrder, updateOrderItem } from '../../api/generated/orders/orders';
import type { BillingParty, Order, OrderItem, WorkItem } from '../../api/generated/models';
import { FuzzyComboBox } from '../../app/components/FuzzyComboBox';
import { formatDateTime } from '../../app/dateTime';
import { fuzzyScore } from '../../app/fuzzy';
import { useNotify } from '../machinelogbook/shared/toasts';
import { billingPartySearchQuery } from '../machinelogbook/queries';
import { formatMoney } from './formatting';
import { parseDecimalInput } from './money';
import { customerJobsQuery, useFinanceMutation } from './queries';

/** Creates a draft (order = null) or edits the customer of an existing draft. */
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
        await updateOrder(order.id, { customer: target, expectedVersion: order.version });
        return order.id;
      }
      return (await createOrder({ customer: target })).id;
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
      onRequestSubmit={() => void form.handleSubmit((values) => mutation.mutate(values))()}
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

const jobHeaders = [
  { key: 'job', header: 'Job' },
  { key: 'title', header: 'Title' },
  { key: 'machine', header: 'Machine' },
  { key: 'ended', header: 'Ended' },
  { key: 'price', header: 'Price' },
];
// On a phone these columns fold into a second line under the job number.
const foldedColumns = new Set(['title', 'machine', 'ended']);

/**
 * Adds a finished job of the order's customer that is on no order yet. Laid out like the material picker of a job: a
 * wide dialog with a search over the jobs and a table to choose one from.
 */
export function AddJobsModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const [selected, setSelected] = useState<WorkItem | null>(null);
  const [search, setSearch] = useState('');
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
  const visible = choices
    .map((job) => ({
      job,
      score: fuzzyScore(search, [job.displayId, job.title, job.fileName, job.machineName].filter(Boolean).join(' ')),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.job);
  return (
    <Modal
      open
      size="lg"
      className="sales-picker"
      modalHeading="Add a job"
      modalLabel={order.reference}
      primaryButtonText={mutation.isPending ? 'Adding…' : 'Add job'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!selected || mutation.isPending}
      preventCloseOnClickOutside
      hasScrollingContent
      selectorPrimaryFocus="#order-job-search"
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => mutation.mutate()}
    >
      <Stack gap={5}>
        <p>
          Finished jobs of {order.customerName ?? 'this customer'} that are on no order yet. The job is added with its
          price as of now; prices freeze when the order is finalized.
        </p>
        <Search
          id="order-job-search"
          size="lg"
          labelText="Search jobs"
          placeholder="Search job, title, file, machine"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoComplete="off"
        />
        {jobs.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="The jobs could not be loaded"
            subtitle="Close the dialog and try again."
          />
        )}
        <DataTable rows={visible.map((job) => ({ id: job.id }))} headers={jobHeaders} size="md" radio>
          {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
            <TableContainer className="sales-picker__table">
              <Table {...getTableProps()} aria-label="Jobs of this customer">
                <TableHead>
                  <TableRow>
                    <th scope="col" className="cds--table-column-checkbox">
                      <span className="cds--visually-hidden">Select</span>
                    </th>
                    {headers.map((header) => {
                      const { key, ...props } = getHeaderProps({ header });
                      return (
                        <TableHeader
                          key={key}
                          {...props}
                          className={foldedColumns.has(header.key) ? 'sales-picker__wide' : undefined}
                        >
                          {header.header}
                        </TableHeader>
                      );
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => {
                    const job = visible.find((candidate) => candidate.id === row.id);
                    if (!job) return null;
                    const { key, ...rowProps } = getRowProps({ row });
                    const isSelected = selected?.id === job.id;
                    const pick = () => {
                      setSelected(job);
                      mutation.reset();
                    };
                    return (
                      <TableRow
                        key={key}
                        {...rowProps}
                        isSelected={isSelected}
                        className="sales-picker__row"
                        onClick={(event: MouseEvent<HTMLElement>) => {
                          if (!(event.target as HTMLElement).closest('input, label')) pick();
                        }}
                      >
                        <TableSelectRow
                          radio
                          id={`order-job-${job.id}`}
                          name="order-job"
                          aria-label={`Select ${job.displayId}`}
                          checked={isSelected}
                          onSelect={pick}
                        />
                        <TableCell>
                          <span className="sales-picker__nowrap">{job.displayId}</span>
                          <span className="sales-picker__folded sales-secondary">
                            {[job.title || job.fileName, job.machineName, formatDateTime(job.endsAt ?? job.startedAt)]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </TableCell>
                        <TableCell className="sales-picker__wide">{job.title || job.fileName || '—'}</TableCell>
                        <TableCell className="sales-picker__wide">{job.machineName}</TableCell>
                        <TableCell className="sales-picker__wide sales-picker__nowrap">
                          {formatDateTime(job.endsAt ?? job.startedAt)}
                        </TableCell>
                        <TableCell className="sales-picker__nowrap">
                          {job.effectivePrice ? (
                            formatMoney(job.effectivePrice)
                          ) : (
                            <span className="sales-secondary">Price incomplete</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {jobs.isSuccess && visible.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={jobHeaders.length + 1}>
                        {choices.length === 0
                          ? `${order.customerName ?? 'This customer'} has no finished job that is not on an order.`
                          : 'No job matches.'}
                      </TableCell>
                    </TableRow>
                  )}
                  {jobs.isPending && !!order.customer && (
                    <TableRow>
                      <TableCell colSpan={jobHeaders.length + 1}>Loading jobs…</TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DataTable>
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
