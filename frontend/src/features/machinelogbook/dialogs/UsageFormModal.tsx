import { useState } from 'react';
import { Button, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, NumberInput, Select, SelectItem, Stack, TextInput } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, FormProvider, useFieldArray, useForm, useFormContext } from 'react-hook-form';
import { replaceMachineJobUsages } from '../../../api/generated/machine-jobs/machine-jobs';
import type { MachineJob } from '../../../api/generated/models';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { machineLogbookKeys, materialsQuery, spoolsQuery } from '../queries';
import { formatQuantity } from '../shared/format';
import { useCan } from '../shared/useCan';
import { useNotify } from '../shared/toasts';
import { blankUsage, jobOrderQuery, saveError, toUsageInputs, usageRowsFromJob, type UsagesValues } from './jobFormHelpers';
import '../styles/jobs.scss';

function UsageRowFields({ idPrefix, index, onRemove, canReadInventory }: { idPrefix: string; index: number; onRemove: () => void; canReadInventory: boolean }) {
  const { control, register, watch, setValue } = useFormContext<UsagesValues>();
  const row = watch(`usages.${index}`);
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: canReadInventory });
  const spools = useQuery({ ...spoolsQuery({ consumable: true, materialId: row.materialId, page: 1, pageSize: 100 }), enabled: canReadInventory && row.ownership === 'makerspace' && !!row.materialId });
  const materialItems = (materials.data?.items ?? []).filter((item) => item.active || item.id === row.materialId);
  const unit = materialItems.find((item) => item.id === row.materialId)?.unit;
  const spoolItems = spools.data?.items ?? [];
  return (
    <div className="mj-usage-row">
      <Select id={`${idPrefix}-ownership`} labelText="Ownership" {...register(`usages.${index}.ownership`)}>
        <SelectItem value="makerspace" text="Makerspace stock" />
        <SelectItem value="external" text="Customer / external" />
      </Select>
      {row.ownership === 'makerspace' ? (
        <>
          <Controller control={control} name={`usages.${index}.materialId`} rules={{ required: true }} render={({ field }) => (
            <Select
              id={`${idPrefix}-material`} labelText="Material" value={field.value}
              onChange={(event) => { field.onChange(event.target.value); setValue(`usages.${index}.spoolId`, ''); setValue(`usages.${index}.spoolLabel`, undefined); }}
            >
              <SelectItem value="" text="Select a material" />
              {row.materialId && !materialItems.some((item) => item.id === row.materialId) && <SelectItem value={row.materialId} text={row.materialLabel ?? 'Current material'} />}
              {materialItems.map((item) => <SelectItem key={item.id} value={item.id} text={`${item.name} (${item.unit})`} />)}
            </Select>
          )} />
          <Controller control={control} name={`usages.${index}.spoolId`} render={({ field }) => (
            <Select id={`${idPrefix}-spool`} labelText="Spool (optional)" value={field.value} onChange={(event) => field.onChange(event.target.value)}>
              <SelectItem value="" text="Unassigned stock" />
              {row.spoolId && !spoolItems.some((spool) => spool.id === row.spoolId) && <SelectItem value={row.spoolId} text={row.spoolLabel ?? 'Current spool'} />}
              {spoolItems.map((spool) => <SelectItem key={spool.id} value={spool.id} text={`${spool.displayId}${spool.label ? ` · ${spool.label}` : ''} · ${formatQuantity(spool.remainingQuantity)} ${spool.unit ?? 'g'} left`} />)}
            </Select>
          )} />
        </>
      ) : (
        <TextInput id={`${idPrefix}-name`} labelText="Material name" {...register(`usages.${index}.externalName`, { required: true })} />
      )}
      <Controller
        control={control}
        name={`usages.${index}.quantity`}
        rules={{ validate: (value) => Number(value) > 0 }}
        render={({ field: quantity, fieldState }) => (
          <NumberInput
            id={`${idPrefix}-quantity`} label={unit ? `Quantity (${unit})` : 'Quantity'} allowEmpty min={0} step={1} hideSteppers
            value={quantity.value} invalid={fieldState.invalid} invalidText="Enter a quantity above zero."
            onChange={(_event, state) => quantity.onChange(state.value === '' ? '' : Number(state.value))}
          />
        )}
      />
      <Select id={`${idPrefix}-basis`} labelText="Basis" {...register(`usages.${index}.quantityBasis`)}>
        <SelectItem value="actual" text="Actual" />
        <SelectItem value="estimated" text="Estimated" />
      </Select>
      <Button hasIconOnly kind="ghost" renderIcon={TrashCan} iconDescription="Remove material usage" tooltipPosition="left" onClick={onRemove} />
    </div>
  );
}

export function UsageRowsEditor({ idPrefix }: { idPrefix: string }) {
  const can = useCan();
  const canReadInventory = can('inventory.read');
  const { control } = useFormContext<UsagesValues>();
  const { fields, append, remove } = useFieldArray({ control, name: 'usages' });
  return (
    <Stack gap={5}>
      {!canReadInventory && <InlineNotification kind="info" lowContrast hideCloseButton title="Inventory lookup unavailable" subtitle="Inventory read access is needed to choose other materials or spools. Existing rows keep their material." />}
      {fields.length === 0 && <p className="mj-secondary">No material recorded. The job will be priced for machine time only.</p>}
      {fields.map((field, index) => (
        <UsageRowFields key={field.id} idPrefix={`${idPrefix}-${field.id}`} index={index} canReadInventory={canReadInventory} onRemove={() => remove(index)} />
      ))}
      <div><Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => append(blankUsage())}>Add material</Button></div>
    </Stack>
  );
}

function UsageForm({ onClose, job }: { onClose: () => void; job: MachineJob }) {
  const client = useQueryClient();
  const notify = useNotify();
  const can = useCan();
  const association = useQuery({ ...jobOrderQuery(job.id), enabled: can('orders.read') });
  const form = useForm<UsagesValues>({ defaultValues: { usages: usageRowsFromJob(job.usages) } });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (values: UsagesValues) => replaceMachineJobUsages(job.id, { usages: toUsageInputs(values.usages), expectedVersion: job.version }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: 'Material usage updated', subtitle: `${job.displayId} price recalculated.` });
      guard.bypassAfterSubmit(onClose);
    },
    onError: (cause) => setError(saveError(cause, 'The material usage could not be saved.').message),
  });
  const pending = mutation.isPending;
  const submit = form.handleSubmit((values) => { setError(null); mutation.mutate(values); }, () => setError('Every row needs a material and a quantity above zero.'));

  return (
    <>
      <ComposedModal open={!guard.dialogOpen} size="lg" preventCloseOnClickOutside onClose={() => { if (!pending) guard.requestDiscard(onClose); return false; }} aria-label="Edit material usage">
        <ModalHeader title="Edit material usage" label={job.displayId} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              <p>Saving replaces the full list of consumed material. Stock is adjusted and the calculated price is recalculated. Existing order charges stay unchanged.</p>
              {association.data?.orderId && <InlineNotification kind="warning" lowContrast hideCloseButton title={`On ${association.data.orderReference}`} subtitle="Correct the order separately after changing usage." />}
              {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Material usage not saved" subtitle={error} />}
              <UsageRowsEditor idPrefix={`usage-${job.displayId}`} />
            </Stack>
          </FormProvider>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={() => guard.requestDiscard(onClose)}>Cancel</Button>
          <Button kind="primary" disabled={pending} onClick={submit}>{pending ? 'Saving…' : 'Save usage'}</Button>
        </ModalFooter>
      </ComposedModal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

export function UsageFormModal({ open, onClose, job }: { open: boolean; onClose: () => void; job: MachineJob }) {
  return open ? <UsageForm onClose={onClose} job={job} /> : null;
}
