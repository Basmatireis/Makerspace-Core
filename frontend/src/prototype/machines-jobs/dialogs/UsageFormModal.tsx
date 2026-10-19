import { RichNotification, RefLink } from '../components/RefLink';
import { useState } from 'react';
import { Button, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, NumberInput, Select, SelectItem, Stack, TextInput } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { Controller, FormProvider, useFieldArray, useForm, useFormContext } from 'react-hook-form';
import { isConsumable } from '../components/inventoryShared';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { useSimulatedMutation, useStore } from '../store';
import type { Job } from '../types';
import { blankUsage, toUsageInputs, usageRowsFromJob, type UsagesValues } from './jobFormHelpers';
import '../styles/jobs.scss';

export function UsageRowsEditor({ idPrefix }: { idPrefix: string }) {
  const { spools, materials } = useStore();
  const { control, register, watch, setValue } = useFormContext<UsagesValues>();
  const { fields, append, remove } = useFieldArray({ control, name: 'usages' });
  return (
    <Stack gap={5}>
      {fields.length === 0 && <p className="mj-secondary">No material recorded. The job will be priced for machine time only.</p>}
      {fields.map((field, index) => {
        const ownership = watch(`usages.${index}.ownership`);
        const materialId = watch(`usages.${index}.materialId`);
        const unit = materials.find((item) => item.id === materialId)?.unit;
        const id = `${idPrefix}-${field.id}`;
        return (
          <div className="mj-usage-row" key={field.id}>
            <Select id={`${id}-ownership`} labelText="Ownership" {...register(`usages.${index}.ownership`)}>
              <SelectItem value="makerspace" text="Makerspace stock" />
              <SelectItem value="external" text="Customer / external" />
            </Select>
            {ownership === 'makerspace' ? (
              <>
                <Select id={`${id}-material`} labelText="Material" {...register(`usages.${index}.materialId`, { required: true, onChange: () => setValue(`usages.${index}.spoolId`, '') })}>
                  <SelectItem value="" text="Select a material" />
                  {materials.filter((item) => item.active).map((item) => <SelectItem key={item.id} value={item.id} text={`${item.name} (${item.unit})`} />)}
                </Select>
                <Select id={`${id}-spool`} labelText="Spool (optional)" {...register(`usages.${index}.spoolId`)}>
                  <SelectItem value="" text="Unassigned stock" />
                  {spools.filter((spool) => spool.materialId === materialId && (isConsumable(spool) || spool.id === watch(`usages.${index}.spoolId`)))
                    .map((spool) => <SelectItem key={spool.id} value={spool.id} text={`${spool.displayId}${spool.label ? ` · ${spool.label}` : ''} · ${spool.remainingQuantity} g left`} />)}
                </Select>
              </>
            ) : (
              <TextInput id={`${id}-name`} labelText="Material name" {...register(`usages.${index}.externalName`, { required: true })} />
            )}
            <Controller
              control={control}
              name={`usages.${index}.quantity`}
              rules={{ validate: (value) => Number(value) > 0 }}
              render={({ field: quantity, fieldState }) => (
                <NumberInput
                  id={`${id}-quantity`} label={unit ? `Quantity (${unit})` : 'Quantity'} allowEmpty min={0} step={1} hideSteppers
                  value={quantity.value} invalid={fieldState.invalid} invalidText="Enter a quantity above zero."
                  onChange={(_event, state) => quantity.onChange(state.value === '' ? '' : Number(state.value))}
                />
              )}
            />
            <Select id={`${id}-basis`} labelText="Basis" {...register(`usages.${index}.quantityBasis`)}>
              <SelectItem value="actual" text="Actual" />
              <SelectItem value="estimated" text="Estimated" />
            </Select>
            <Button hasIconOnly kind="ghost" renderIcon={TrashCan} iconDescription="Remove material usage" tooltipPosition="left" onClick={() => remove(index)} />
          </div>
        );
      })}
      <div><Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => append(blankUsage())}>Add material</Button></div>
    </Stack>
  );
}

function UsageForm({ onClose, job }: { onClose: () => void; job: Job }) {
  const store = useStore();
  const form = useForm<UsagesValues>({ defaultValues: { usages: usageRowsFromJob(job.usages) } });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [invalid, setInvalid] = useState(false);
  const { mutate, pending } = useSimulatedMutation((values: UsagesValues) => store.replaceUsages(job.id, toUsageInputs(values.usages)));
  const submit = form.handleSubmit(async (values) => {
    setInvalid(false);
    await mutate(values);
    store.notify({ kind: 'success', title: 'Material usage updated', subtitle: `${job.displayId} price recalculated.` });
    guard.bypassAfterSubmit(onClose);
  }, () => setInvalid(true));

  return (
    <>
      <ComposedModal open={!guard.dialogOpen} size="lg" preventCloseOnClickOutside onClose={() => { if (!pending) guard.requestDiscard(onClose); return false; }} aria-label="Edit material usage">
        <ModalHeader title="Edit material usage" label={job.displayId} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              <p>Saving replaces the full list of consumed material. Stock is adjusted and the calculated price is recalculated. Existing order charges stay unchanged.</p>
              {job.order && <RichNotification kind="warning" title="On an order"><RefLink reference={job.order.orderReference} id={job.order.orderId} onNavigate={onClose} />. Correct the order separately after changing usage.</RichNotification>}
              {invalid && <InlineNotification kind="error" lowContrast hideCloseButton title="Check the material rows" subtitle="Every row needs a material and a quantity above zero." />}
              <UsageRowsEditor idPrefix={`usage-${job.id}`} />
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

export function UsageFormModal({ open, onClose, job }: { open: boolean; onClose: () => void; job: Job }) {
  return open ? <UsageForm onClose={onClose} job={job} /> : null;
}
