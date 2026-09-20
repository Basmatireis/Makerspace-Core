import {
  Button,
  ComboBox,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createMachineJob } from '../../api/generated/machine-jobs/machine-jobs';
import type { BillingParty, MachineJobOutcome, Operator } from '../../api/generated/models';
import {
  billingPartySearchQuery,
  machineLogbookKeys,
  machinesQuery,
  materialsQuery,
  operatorSearchQuery,
  pricingQuery,
} from './queries';

type CreateJobFields = {
  machineId: string;
  startsAt: string;
  endsAt: string;
  customer: BillingParty | null;
  operator: Operator | null;
  outcome: MachineJobOutcome;
  pricingGroupId: string;
  notes: string;
  usages: Array<{ materialId: string; quantity: string }>;
};

function localDateTime(date: Date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

export function CreateJobModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const form = useForm<CreateJobFields>({
    defaultValues: {
      machineId: '',
      startsAt: localDateTime(oneHourAgo),
      endsAt: localDateTime(now),
      customer: null,
      operator: null,
      outcome: 'successful',
      pricingGroupId: '',
      notes: '',
      usages: [{ materialId: '', quantity: '' }],
    },
  });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'usages' });
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: open });
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: open });
  const pricing = useQuery({ ...pricingQuery(), enabled: open });
  const parties = useQuery({ ...billingPartySearchQuery(customerSearch), enabled: open });
  const operators = useQuery({ ...operatorSearchQuery(operatorSearch), enabled: open });
  const mutation = useMutation({
    mutationFn: (values: CreateJobFields) => {
      if (!values.customer || !values.operator) throw new Error('Customer and operator are required');
      return createMachineJob({
        machineId: values.machineId,
        startsAt: new Date(values.startsAt).toISOString(),
        endsAt: new Date(values.endsAt).toISOString(),
        customer: { kind: values.customer.kind, id: values.customer.id },
        operatorPersonId: values.operator.personId,
        outcome: values.outcome,
        pricingGroupId: values.pricingGroupId || null,
        notes: values.notes || null,
        usages: values.usages
          .filter((usage) => usage.materialId && usage.quantity)
          .map((usage) => ({ materialId: usage.materialId, quantity: usage.quantity })),
      });
    },
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      onClose();
      navigate(`/machine-logbook/jobs/${created.id}`);
    },
  });
  const lookupError = machines.isError || materials.isError || pricing.isError || parties.isError || operators.isError;

  return <Modal
    open={open}
    size="lg"
    modalHeading="New machine job"
    primaryButtonText={mutation.isPending ? 'Creating…' : 'Create job'}
    secondaryButtonText="Cancel"
    primaryButtonDisabled={mutation.isPending || machines.isPending || materials.isPending}
    onRequestClose={onClose}
    onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}
  >
    <Stack gap={6}>
      <p className="section-description">Manual jobs are confirmed immediately. Material usage is deducted atomically when the job is created.</p>
      <Select id="new-job-machine" labelText="Machine" {...form.register('machineId', { required: true })}>
        <SelectItem value="" text={machines.isPending ? 'Loading machines…' : 'Select a machine'} />
        {(machines.data?.items ?? []).filter((machine) => machine.status !== 'retired').map((machine) => <SelectItem key={machine.id} value={machine.id} text={machine.name} />)}
      </Select>
      <div className="form-grid">
        <TextInput id="new-job-start" type="datetime-local" labelText="Start" {...form.register('startsAt', { required: true })} />
        <TextInput id="new-job-end" type="datetime-local" labelText="End" {...form.register('endsAt', { required: true })} />
      </div>
      <div className="form-grid">
        <Controller
          control={form.control}
          name="customer"
          rules={{ required: true }}
          render={({ field, fieldState }) => <ComboBox
            id="new-job-customer"
            titleText="Customer"
            items={parties.data?.items ?? []}
            itemToString={(item) => item?.displayName ?? ''}
            selectedItem={field.value}
            onInputChange={setCustomerSearch}
            onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)}
            invalid={fieldState.invalid}
            invalidText="Select a customer"
            placeholder="Search people or organizations…"
          />}
        />
        <Controller
          control={form.control}
          name="operator"
          rules={{ required: true }}
          render={({ field, fieldState }) => <ComboBox
            id="new-job-operator"
            titleText="Operator"
            items={operators.data?.items ?? []}
            itemToString={(item) => item?.displayName ?? ''}
            selectedItem={field.value}
            onInputChange={setOperatorSearch}
            onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)}
            invalid={fieldState.invalid}
            invalidText="Select an enabled operator"
            placeholder="Search enabled users…"
          />}
        />
      </div>
      <div className="form-grid">
        <Select id="new-job-outcome" labelText="Outcome" {...form.register('outcome')}>
          <SelectItem value="successful" text="Successful" />
          <SelectItem value="partial_failure" text="Partial failure" />
          <SelectItem value="failed" text="Failed" />
          <SelectItem value="cancelled" text="Cancelled" />
          <SelectItem value="unknown" text="Unknown" />
        </Select>
        <Select id="new-job-pricing" labelText="Pricing group" helperText="Leave empty to resolve the customer or global default." {...form.register('pricingGroupId')}>
          <SelectItem value="" text="Use resolved default" />
          {(pricing.data?.items ?? []).filter((group) => group.active).map((group) => <SelectItem key={group.id} value={group.id} text={group.name} />)}
        </Select>
      </div>
      <div>
        <div className="section-heading">
          <div><h3>Material usage</h3><p className="section-description">Add every consumed material, including waste from failed outcomes.</p></div>
          <Button type="button" size="sm" kind="tertiary" renderIcon={Add} onClick={() => append({ materialId: '', quantity: '' })}>Add usage</Button>
        </div>
        <Stack gap={4}>
          {fields.map((field, index) => <div className="usage-row" key={field.id}>
            <Select id={`new-job-material-${field.id}`} labelText="Material" {...form.register(`usages.${index}.materialId`, { required: true })}>
              <SelectItem value="" text="Select a material" />
              {(materials.data?.items ?? []).filter((material) => material.active).map((material) => <SelectItem key={material.id} value={material.id} text={`${material.name} (${material.unit})`} />)}
            </Select>
            <TextInput id={`new-job-quantity-${field.id}`} labelText="Quantity" {...form.register(`usages.${index}.quantity`, { required: true })} />
            <Button type="button" hasIconOnly kind="ghost" renderIcon={TrashCan} iconDescription="Remove material usage" disabled={fields.length === 1} onClick={() => remove(index)} />
          </div>)}
        </Stack>
      </div>
      <TextArea id="new-job-notes" labelText="Notes" {...form.register('notes')} />
      {lookupError && <InlineNotification kind="error" lowContrast hideCloseButton title="Some job choices could not be loaded" subtitle="Check your catalog permissions and retry." />}
      {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Job not created" subtitle="Check stock, dates, pricing, and the selected assignments. Reload if catalog data changed." />}
    </Stack>
  </Modal>;
}
