import { useState } from 'react';
import {
  Button,
  ComposedModal,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Stack,
  TextInput,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, FormProvider, useFieldArray, useForm, useFormContext } from 'react-hook-form';
import { replaceMachineRunUsages } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineProcess, MachineRun } from '../../../api/generated/models';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalValidator, parseDecimalText } from '../../../app/decimalInput';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { materialTypesQuery } from '../inventoryQueries';
import { materialsForProcess, processConfig, unitText } from '../processConfig';
import { machineLogbookKeys, machineQuery, materialsQuery, spoolsQuery } from '../queries';
import { formatQuantity } from '../shared/format';
import { useCan } from '../shared/useCan';
import { useNotify } from '../shared/toasts';
import {
  blankUsage,
  isBlankUsage,
  jobOrderQuery,
  saveError,
  toUsageInputs,
  usageRowsFromUsages,
  type UsagesValues,
} from './jobFormHelpers';
import { inkUsageInputs, splitInkUsages } from './processFormHelpers';
import { InkFields } from './ProcessRunFields';
import '../styles/jobs.scss';

/** Width x height x count in centimetres gives the square centimetres of cut material; the result stays editable. */
function AreaHelper({ idPrefix, onArea }: { idPrefix: string; onArea: (area: number) => void }) {
  const [size, setSize] = useState({ width: '', height: '', count: '1' });
  const change = (key: 'width' | 'height' | 'count', value: string) => {
    const next = { ...size, [key]: value };
    setSize(next);
    const area =
      (decimalNumber(next.width) ?? 0) *
      (decimalNumber(next.height) ?? 0) *
      (decimalNumber(next.count, { integer: true }) ?? 0);
    onArea(Math.round(area * 100) / 100);
  };
  const invalid = (value: string, integer = false) =>
    value.trim() !== '' && parseDecimalText(value, { integer }) === null;
  return (
    <div className="mj-area-helper">
      <DecimalField
        id={`${idPrefix}-width`}
        labelText="Width (cm)"
        value={size.width}
        invalid={invalid(size.width)}
        invalidText="Enter a number, e.g. 12,5."
        onChange={(value) => change('width', value)}
      />
      <DecimalField
        id={`${idPrefix}-height`}
        labelText="Height (cm)"
        value={size.height}
        invalid={invalid(size.height)}
        invalidText="Enter a number, e.g. 12,5."
        onChange={(value) => change('height', value)}
      />
      <DecimalField
        id={`${idPrefix}-count`}
        labelText="Count"
        integer
        value={size.count}
        invalid={invalid(size.count, true)}
        invalidText="Enter a whole number."
        onChange={(value) => change('count', value)}
      />
    </div>
  );
}

function UsageRowFields({
  idPrefix,
  index,
  onRemove,
  canReadInventory,
  process,
}: {
  idPrefix: string;
  index: number;
  onRemove: () => void;
  canReadInventory: boolean;
  process?: MachineProcess;
}) {
  const { control, register, watch, setValue } = useFormContext<UsagesValues>();
  const row = watch(`usages.${index}`);
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: canReadInventory });
  const spools = useQuery({
    ...spoolsQuery({ consumable: true, materialId: row.materialId, page: 1, pageSize: 100 }),
    enabled: canReadInventory && row.ownership === 'makerspace' && !!row.materialId,
  });
  const types = useQuery({ ...materialTypesQuery(), enabled: canReadInventory });
  const config = process ? processConfig[process] : undefined;
  // New choices are limited to active materials whose type fits the machine's process; the row's current material stays.
  const materialItems = materialsForProcess(materials.data?.items ?? [], types.data, process, row.materialId, config);
  const unit = (materials.data?.items ?? []).find((item) => item.id === row.materialId)?.unit;
  const spoolItems = spools.data?.items ?? [];
  const showSpools = !process || process === 'fdm_printing';
  const showArea = Boolean(config?.areaHelper && unit === 'cm2');
  return (
    <div className="mj-usage-row">
      <Select id={`${idPrefix}-ownership`} labelText="Ownership" {...register(`usages.${index}.ownership`)}>
        <SelectItem value="makerspace" text="Makerspace stock" />
        <SelectItem value="external" text="Customer / external" />
      </Select>
      {row.ownership === 'makerspace' ? (
        <>
          <Controller
            control={control}
            name={`usages.${index}.materialId`}
            rules={{ validate: (value, values) => isBlankUsage(values.usages[index]) || Boolean(value) }}
            render={({ field }) => (
              <Select
                id={`${idPrefix}-material`}
                labelText="Material"
                value={field.value}
                onChange={(event) => {
                  field.onChange(event.target.value);
                  setValue(`usages.${index}.spoolId`, '');
                  setValue(`usages.${index}.spoolLabel`, undefined);
                }}
              >
                <SelectItem value="" text="Select a material" />
                {row.materialId && !materialItems.some((item) => item.id === row.materialId) && (
                  <SelectItem value={row.materialId} text={row.materialLabel ?? 'Current material'} />
                )}
                {materialItems.map((item) => (
                  <SelectItem key={item.id} value={item.id} text={`${item.name} (${unitText(item.unit)})`} />
                ))}
              </Select>
            )}
          />
          {showSpools && (
            <Controller
              control={control}
              name={`usages.${index}.spoolId`}
              render={({ field }) => (
                <Select
                  id={`${idPrefix}-spool`}
                  labelText="Spool (optional)"
                  value={field.value}
                  onChange={(event) => field.onChange(event.target.value)}
                >
                  <SelectItem value="" text="Unassigned stock" />
                  {row.spoolId && !spoolItems.some((spool) => spool.id === row.spoolId) && (
                    <SelectItem value={row.spoolId} text={row.spoolLabel ?? 'Current spool'} />
                  )}
                  {spoolItems.map((spool) => (
                    <SelectItem
                      key={spool.id}
                      value={spool.id}
                      text={`${spool.displayId}${spool.label ? ` · ${spool.label}` : ''} · ${formatQuantity(spool.remainingQuantity)} ${spool.unit ?? 'g'} left`}
                    />
                  ))}
                </Select>
              )}
            />
          )}
        </>
      ) : (
        <TextInput
          id={`${idPrefix}-name`}
          labelText="Material name"
          {...register(`usages.${index}.externalName`, {
            validate: (value, values) => isBlankUsage(values.usages[index]) || Boolean(value.trim()),
          })}
        />
      )}
      <Controller
        control={control}
        name={`usages.${index}.quantity`}
        rules={{
          validate: (value, values) =>
            isBlankUsage(values.usages[index]) ||
            decimalValidator({ positive: true, requiredMessage: 'Enter a quantity above zero.' })(value),
        }}
        render={({ field: quantity, fieldState }) => (
          <DecimalField
            id={`${idPrefix}-quantity`}
            labelText={unit ? `Quantity (${unitText(unit)})` : 'Quantity'}
            value={quantity.value}
            invalid={fieldState.invalid}
            invalidText={fieldState.error?.message ?? 'Enter a quantity above zero.'}
            onChange={quantity.onChange}
          />
        )}
      />
      <Select id={`${idPrefix}-basis`} labelText="Basis" {...register(`usages.${index}.quantityBasis`)}>
        <SelectItem value="actual" text="Actual" />
        <SelectItem value="estimated" text="Estimated" />
      </Select>
      <Button
        hasIconOnly
        kind="ghost"
        renderIcon={TrashCan}
        iconDescription="Remove material usage"
        tooltipPosition="left"
        onClick={onRemove}
      />
      {showArea && (
        <AreaHelper
          idPrefix={idPrefix}
          onArea={(area) =>
            setValue(`usages.${index}.quantity`, String(area), { shouldDirty: true, shouldValidate: true })
          }
        />
      )}
    </div>
  );
}

/** Material rows of a run. `process` limits the materials to the ones the machine's process can use; the ink group of UV printing has its own fields. */
export function UsageRowsEditor({ idPrefix, process }: { idPrefix: string; process?: MachineProcess }) {
  const can = useCan();
  const canReadInventory = can('inventory.read');
  const { control } = useFormContext<UsagesValues>();
  const { fields, append, remove } = useFieldArray({ control, name: 'usages' });
  return (
    <Stack gap={5}>
      {!canReadInventory && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Inventory lookup unavailable"
          subtitle="Inventory read access is needed to choose other materials or spools. Existing rows keep their material."
        />
      )}
      {process && processConfig[process].inkGroup && <InkFields idPrefix={idPrefix} process={process} />}
      {fields.length === 0 ? (
        <p className="mj-secondary">No material recorded. The run is priced for machine time only.</p>
      ) : (
        <p className="mj-secondary">Leave a row empty or remove it to record no material.</p>
      )}
      {fields.map((field, index) => (
        <UsageRowFields
          key={field.id}
          idPrefix={`${idPrefix}-${field.id}`}
          index={index}
          canReadInventory={canReadInventory}
          process={process}
          onRemove={() => remove(index)}
        />
      ))}
      <div>
        <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => append(blankUsage())}>
          Add material
        </Button>
      </div>
    </Stack>
  );
}

function UsageForm({ onClose, run }: { onClose: () => void; run: MachineRun }) {
  const can = useCan();
  const association = useQuery({ ...jobOrderQuery(run.job?.id ?? ''), enabled: can('orders.read') && !!run.job });
  const machine = useQuery({ ...machineQuery(run.machineId), enabled: can('machines.read') });
  const process = machine.data?.machineType.process;
  // The form is built once the machine's process is known, so ink usages land in their own fields.
  if (can('machines.read') && machine.isPending) return null;
  return <UsageFormBody onClose={onClose} run={run} process={process} association={association.data} />;
}

function UsageFormBody({
  onClose,
  run,
  process,
  association,
}: {
  onClose: () => void;
  run: MachineRun;
  process?: MachineProcess;
  association?: { orderId?: string | null; orderReference?: string | null };
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const { ink, rest } = splitInkUsages(run.usages, process);
  const form = useForm<UsagesValues>({ defaultValues: { usages: usageRowsFromUsages(rest), ink } });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (values: UsagesValues) =>
      replaceMachineRunUsages(run.id, {
        usages: [...toUsageInputs(values.usages), ...inkUsageInputs(values.ink ?? {})],
        expectedVersion: run.version,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: 'Material usage updated',
        subtitle: run.job
          ? `${run.displayId} saved; ${run.job.displayId} price recalculated.`
          : `${run.displayId} saved.`,
      });
      guard.bypassAfterSubmit(onClose);
    },
    onError: (cause) => setError(saveError(cause, 'The material usage could not be saved.').message),
  });
  const pending = mutation.isPending;
  const submit = form.handleSubmit(
    (values) => {
      setError(null);
      mutation.mutate(values);
    },
    () => setError('Every row needs a material and a quantity above zero.'),
  );

  return (
    <>
      <ComposedModal
        open={!guard.dialogOpen}
        size="lg"
        preventCloseOnClickOutside
        onClose={() => {
          if (!pending) guard.requestDiscard(onClose);
          return false;
        }}
        aria-label="Edit material usage"
      >
        <ModalHeader title="Edit material usage" label={run.displayId} />
        <ModalBody hasForm>
          <FormProvider {...form}>
            <Stack gap={6}>
              <p>
                Saving replaces the full list of material consumed by this run. Stock is adjusted and the calculated
                price is recalculated. Existing order charges stay unchanged.
              </p>
              {run.usagesFromMachine && (
                <InlineNotification
                  kind="info"
                  lowContrast
                  hideCloseButton
                  title="Reported by the machine"
                  subtitle="This material was consumed automatically from the machine's report. Saving replaces it with your entries."
                />
              )}
              {association?.orderId && (
                <InlineNotification
                  kind="warning"
                  lowContrast
                  hideCloseButton
                  title={`On ${association.orderReference}`}
                  subtitle="Correct the order separately after changing usage."
                />
              )}
              {error && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Material usage not saved"
                  subtitle={error}
                />
              )}
              <UsageRowsEditor idPrefix={`usage-${run.displayId}`} process={process} />
            </Stack>
          </FormProvider>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={() => guard.requestDiscard(onClose)}>
            Cancel
          </Button>
          <Button kind="primary" disabled={pending} onClick={submit}>
            {pending ? 'Saving…' : 'Save usage'}
          </Button>
        </ModalFooter>
      </ComposedModal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

/** Replaces the material usage of one run (manual or recorded). */
export function UsageFormModal({ open, onClose, run }: { open: boolean; onClose: () => void; run: MachineRun }) {
  return open ? <UsageForm onClose={onClose} run={run} /> : null;
}
