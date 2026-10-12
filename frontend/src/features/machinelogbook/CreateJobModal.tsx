import {
  Button,
  ComboBox,
  InlineNotification,
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
import { useCurrentUser } from '../auth/auth';
import { canLookupJobParties, hasPermission, PermissionId } from '../auth/permissions';
import { CatalogFormModal } from './CatalogFormModal';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useLatestCallback } from '../../app/useLatestCallback';
import { DateTimeInput } from '../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../app/dateTime';
import { createMachineJob, updateMachineJob, replaceMachineJobUsages } from '../../api/generated/machine-jobs/machine-jobs';
import type { BillingParty, MachineJob, MachineJobOutcome, Operator } from '../../api/generated/models';
import {
  billingPartySearchQuery,
  machineLogbookKeys,
  machinesQuery,
  materialsQuery,
  operatorSearchQuery,
  pricingQuery,
  spoolsQuery,
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
  usages: Array<{ ownership: 'makerspace' | 'external'; materialId: string; spoolId: string; externalMaterialName: string; quantity: string; quantityBasis: 'actual' | 'estimated' }>;
};

export function CreateJobModal({ open, onClose, job, mode = 'create' }: { open: boolean; onClose: () => void; job?: MachineJob; mode?: 'create' | 'facts' | 'usages' }) {
  const navigate = useNavigate();
  const currentUser = useCurrentUser();
  const canReadMachines = hasPermission(currentUser, PermissionId.machinesread);
  const canReadInventory = hasPermission(currentUser, PermissionId.inventoryread);
  const canReadPricing = hasPermission(currentUser, PermissionId.pricingread);
  const canLookup = canLookupJobParties(currentUser);
  const canSave = hasPermission(currentUser, mode === 'create' ? PermissionId.machine_jobscreate : PermissionId.machine_jobsedit);
  const showFacts = mode !== 'usages';
  const showUsages = mode !== 'facts';
  const client = useQueryClient();
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const form = useForm<CreateJobFields>({
    shouldUnregister: true,
    defaultValues: {
      machineId: job?.machine.id ?? '',
      startsAt: instantToZonedDateTimeValue(job?.startsAt ?? oneHourAgo),
      endsAt: instantToZonedDateTimeValue(job?.endsAt ?? now),
      customer: job?.customer ?? null,
      operator: job?.operator ?? null,
      outcome: job?.outcome ?? 'successful',
      pricingGroupId: '',
      notes: job?.notes ?? '',
      usages: job ? job.usages.map((usage) => ({ ownership: usage.ownership, materialId: usage.materialId ?? '', spoolId: usage.spoolId ?? '', externalMaterialName: usage.ownership === 'external' ? usage.materialName : '', quantity: usage.quantity, quantityBasis: usage.quantityBasis })) : [{ ownership: 'makerspace', materialId: '', spoolId: '', externalMaterialName: '', quantity: '', quantityBasis: 'actual' }],
    },
  });
  const guard = useUnsavedChanges({ isDirty: open && form.formState.isDirty });
  const { fields, append, remove } = useFieldArray({ control: form.control, name: 'usages' });
  const [customerSearch, setCustomerSearch] = useState('');
  const [operatorSearch, setOperatorSearch] = useState('');
  const machines = useQuery({ ...machinesQuery({ page: 1, pageSize: 100 }), enabled: open && showFacts && canReadMachines });
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: open && showUsages && canReadInventory });
  const spools = useQuery({ ...spoolsQuery({ lifecycle: 'active', page: 1, pageSize: 100 }), enabled: open && showUsages && canReadInventory });
  const pricing = useQuery({ ...pricingQuery(), enabled: open && showFacts && canReadPricing });
  const parties = useQuery({ ...billingPartySearchQuery(customerSearch), enabled: open && showFacts && canLookup });
  const operators = useQuery({ ...operatorSearchQuery(operatorSearch), enabled: open && showFacts && canLookup });
  const mutation = useMutation({
    mutationFn: (values: CreateJobFields) => {
      if (!canSave) throw new Error('Job changes are not permitted');
      const usages = (values.usages ?? []).map((usage) => ({ ownership: usage.ownership, materialId: usage.ownership === 'makerspace' ? usage.materialId : null, spoolId: usage.ownership === 'makerspace' ? usage.spoolId || null : null, externalMaterialName: usage.ownership === 'external' ? usage.externalMaterialName : null, quantity: usage.quantity, quantityBasis: usage.quantityBasis }));
      if (mode === 'usages' && job) return replaceMachineJobUsages(job.id, { usages, expectedVersion: job.version });
      if (!values.operator || (mode === 'create' && !values.customer)) throw new Error('Customer and operator are required');
      const facts = { machineId: values.machineId, startsAt: zonedDateTimeValueToISO(values.startsAt), endsAt: zonedDateTimeValueToISO(values.endsAt), customer: values.customer ? { kind: values.customer.kind, id: values.customer.id } : undefined, operatorPersonId: values.operator.personId, outcome: values.outcome, pricingGroupId: values.pricingGroupId || null, notes: values.notes || null };
      return mode === 'facts' && job ? updateMachineJob(job.id, { ...facts, expectedVersion: job.version }) : createMachineJob({ ...facts, customer: facts.customer!, usages });
    },
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      form.reset();
      guard.bypassAfterSubmit(() => { onClose(); if (mode === 'create') navigate(`/machine-logbook/jobs/${created.id}`); });
    },
  });
  const lookupError = machines.isError || materials.isError || spools.isError || pricing.isError || parties.isError || operators.isError;

  const close = useLatestCallback(() => { if (!mutation.isPending) guard.requestDiscard(onClose); });
  const machineChoices = [...(job && !machines.data?.items.some((item) => item.id === job.machine.id) ? [job.machine] : []), ...(machines.data?.items ?? [])];
  const requiredLookupMissing = showFacts && ((!canReadMachines && !job) || (!canLookup && !job?.operator));
  return <><CatalogFormModal
    open={open && !guard.dialogOpen}
    size="lg"
    modalHeading={mode === 'create' ? 'New machine job' : mode === 'facts' ? 'Edit machine job' : 'Edit material usage'}
    selectorPrimaryFocus={showFacts ? '#new-job-machine' : undefined}
    primaryButtonText={mutation.isPending ? 'Saving…' : mode === 'create' ? 'Create job' : 'Save changes'}
    secondaryButtonText="Cancel"
    primaryButtonDisabled={mutation.isPending || !canSave || requiredLookupMissing || (showFacts && canReadMachines && machines.isPending)}
    preventCloseOnClickOutside
    onRequestClose={close}
    onRequestSubmit={form.handleSubmit((values) => { if (!mutation.isPending && canSave && !requiredLookupMissing) mutation.mutate(values); })}
  >
    <Stack gap={6}>
      <p className="section-description">{mode === 'create' ? 'Manual jobs are confirmed immediately. Material usage is deducted atomically when the job is created.' : mode === 'usages' ? 'Saving reverses the old stock consumption and applies the complete replacement usage atomically. Recorded transactions and pricing history remain available.' : 'Changing the customer or machine type captures a new pricing snapshot. Existing order charges remain immutable; correct those through the order workflow.'}</p>
      {showFacts && <>
      {!canReadMachines && <InlineNotification kind="info" hideCloseButton title="Machine lookup unavailable" subtitle={job ? 'The current machine is retained. Machine read permission is required to choose another machine.' : 'Machine read permission is required to create a job.'} />}
      <Select id="new-job-machine" labelText="Machine" value={form.watch('machineId')} readOnly={!canReadMachines} invalid={!!form.formState.errors.machineId} invalidText="Select a machine." {...form.register('machineId', { required: true })}>
        <SelectItem value="" text={machines.isPending ? 'Loading machines…' : 'Select a machine'} />
        {machineChoices.filter((machine) => machine.status !== 'retired' || machine.id === job?.machine.id).map((machine) => <SelectItem key={machine.id} value={machine.id} text={machine.name} />)}
      </Select>
      <div className="form-grid">
        <Controller control={form.control} name="startsAt" rules={{ validate: isZonedDateTimeValue }} render={({ field }) => <DateTimeInput id="new-job-start" labelText="Start" value={field.value} onChange={field.onChange} required />} />
        <Controller control={form.control} name="endsAt" rules={{ validate: isZonedDateTimeValue }} render={({ field }) => <DateTimeInput id="new-job-end" labelText="End" value={field.value} onChange={field.onChange} required />} />
      </div>
      <div className="form-grid">
        <Controller
          control={form.control}
          name="customer"
          rules={{ required: mode === 'create' }}
          render={({ field, fieldState }) => <ComboBox
            id="new-job-customer"
            disabled={!canLookup}
            titleText="Customer"
            items={parties.data?.items ?? (job?.customer ? [job.customer] : [])}
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
            disabled={!canLookup}
            titleText="Operator"
            items={operators.data?.items ?? (job?.operator ? [job.operator] : [])}
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
      {!canLookup && <p className="section-description">Customer and operator lookups are unavailable with your permissions. Existing assignments are retained.</p>}
      <div className="form-grid">
        <Select id="new-job-outcome" labelText="Outcome" {...form.register('outcome')}>
          <SelectItem value="successful" text="Successful" />
          <SelectItem value="partial_failure" text="Partial failure" />
          <SelectItem value="failed" text="Failed" />
          <SelectItem value="cancelled" text="Cancelled" />
          <SelectItem value="unknown" text="Unknown" />
        </Select>
        <Select id="new-job-pricing" labelText="Pricing group" disabled={!canReadPricing} helperText="Leave empty to resolve the customer or global default." {...form.register('pricingGroupId')}>
          <SelectItem value="" text="Use resolved default" />
          {(pricing.data?.items ?? []).filter((group) => group.active).map((group) => <SelectItem key={group.id} value={group.id} text={group.name} />)}
        </Select>
      </div>
      {!canReadPricing && <p className="section-description">Pricing lookup is unavailable. The existing snapshot or resolved default is used.</p>}
      <TextArea id="new-job-notes" labelText="Notes" {...form.register('notes')} />
      </>}
      {showUsages && <div>
        {!canReadInventory && <InlineNotification kind="info" hideCloseButton title="Inventory lookup unavailable" subtitle="Inventory read permission is required to select stock. Existing usage can be corrected; choose external material or remove an unused row for a new job." />}
        <div className="section-heading">
          <div><h3>Material usage</h3><p className="section-description">Add every consumed material, including waste from failed outcomes.</p></div>
          <Button type="button" size="sm" kind="tertiary" renderIcon={Add} onClick={() => append({ ownership: 'makerspace', materialId: '', spoolId: '', externalMaterialName: '', quantity: '', quantityBasis: 'actual' })}>Add usage</Button>
        </div>
        <Stack gap={4}>
          {fields.map((field, index) => {
            const ownership = form.watch(`usages.${index}.ownership`);
            const materialId = form.watch(`usages.${index}.materialId`);
            return <div className="usage-row usage-row--filament" key={field.id}>
              <Select id={`new-job-ownership-${field.id}`} labelText="Ownership" {...form.register(`usages.${index}.ownership`)}><SelectItem value="makerspace" text="Makerspace" /><SelectItem value="external" text="Customer / external" /></Select>
              {ownership === 'makerspace' ? <>
                <Select id={`new-job-material-${field.id}`} labelText="Material" readOnly={!canReadInventory} value={form.watch(`usages.${index}.materialId`)} {...form.register(`usages.${index}.materialId`, { required: true })}>
                  <SelectItem value="" text="Select a material" />
                  {(materials.data?.items ?? job?.usages.filter((usage) => usage.materialId).map((usage) => ({ id: usage.materialId!, name: usage.materialName, unit: usage.unit, active: true })) ?? []).filter((material) => material.active || material.id === materialId).map((material) => <SelectItem key={material.id} value={material.id} text={`${material.name} (${material.unit})`} />)}
                </Select>
                <Select id={`new-job-spool-${field.id}`} labelText="Spool (optional)" readOnly={!canReadInventory} value={form.watch(`usages.${index}.spoolId`)} {...form.register(`usages.${index}.spoolId`)}><SelectItem value="" text="Unassigned stock" />{job?.usages[index]?.spoolId && !spools.data?.items.some((spool) => spool.id === job.usages[index]?.spoolId) && <SelectItem value={job.usages[index].spoolId!} text={job.usages[index].spoolDisplayId ?? job.usages[index].spoolId!} />}{(spools.data?.items ?? []).filter((spool) => spool.materialId === materialId && !spool.mounted).map((spool) => <SelectItem key={spool.id} value={spool.id} text={`${spool.displayId} · ${spool.remainingQuantity} ${spool.unit}`} />)}</Select>
              </> : <TextInput id={`new-job-external-${field.id}`} labelText="External material" {...form.register(`usages.${index}.externalMaterialName`, { required: true })} />}
              <TextInput id={`new-job-quantity-${field.id}`} labelText="Quantity" {...form.register(`usages.${index}.quantity`, { required: true })} />
              <Select id={`new-job-basis-${field.id}`} labelText="Basis" {...form.register(`usages.${index}.quantityBasis`)}><SelectItem value="actual" text="Actual" /><SelectItem value="estimated" text="Estimated" /></Select>
              <Button type="button" hasIconOnly kind="ghost" renderIcon={TrashCan} iconDescription="Remove material usage"  onClick={() => remove(index)} />
            </div>;
          })}
        </Stack>
      </div>}
      {lookupError && <InlineNotification kind="error" lowContrast hideCloseButton title="Some job choices could not be loaded" subtitle="Check your catalog permissions and retry." />}
      {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Job not saved" subtitle="Check stock, dates, pricing, and the selected assignments. Reload if catalog data changed." />}
    </Stack>
  </CatalogFormModal><UnsavedChangesDialog guard={guard} /></>;
}
