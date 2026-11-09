import { useEffect, useState } from 'react';
import {
  Button,
  ComposedModal,
  FormLabel,
  IconButton,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
} from '@carbon/react';
import { Add, Search, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, FormProvider, useFieldArray, useForm, useFormContext, useWatch } from 'react-hook-form';
import { replaceMachineRunUsages } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRun, MaterialUnit, Process } from '../../../api/generated/models';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { DecimalField } from '../../../app/DecimalField';
import { decimalValidator } from '../../../app/decimalInput';
import { evaluateExpression, isExpression, resolveQuantityText } from '../../../app/quantityExpression';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { materialTypesQuery } from '../inventoryQueries';
import { isFdm, unitText } from '../processConfig';
import { articleUnitLabel, unitSymbol } from '../units';
import { machineLogbookKeys, machineQuery, materialsQuery, spoolsQuery } from '../queries';
import { formatQuantity } from '../shared/format';
import { useCan } from '../shared/useCan';
import { useNotify } from '../shared/toasts';
import {
  blankUsage,
  hasMaterial,
  isBlankUsage,
  jobOrderQuery,
  saveError,
  toUsageInputs,
  usageRowsFromUsages,
  type UsageRow,
  type UsagesValues,
} from './jobFormHelpers';
import { MaterialPickerModal, stockText, type PickedMaterial } from './MaterialPickerModal';
import '../styles/jobs.scss';
import '../jobs/jobs.scss';

/** The chosen material of a row: swatch, name, category and stock, with a button that opens the picker again. */
function SelectedMaterial({
  row,
  colorHex,
  stock,
  onChange,
}: {
  row: UsageRow;
  colorHex?: string | null;
  stock?: string;
  onChange: () => void;
}) {
  const own = row.ownership === 'external';
  const name = own ? row.externalName.trim() || row.materialTypeLabel || 'Recipient’s own material' : row.materialLabel;
  const detail = own
    ? `Recipient’s own${row.materialTypeLabel && row.externalName.trim() ? ` · ${row.materialTypeLabel}` : ''} · not booked, not charged`
    : [row.materialTypeLabel, stock && `${stock} in stock`].filter(Boolean).join(' · ');
  return (
    <div className="jobs-usage__material">
      <span
        className={colorHex ? 'mj-swatch' : 'mj-swatch jobs-usage__swatch--none'}
        style={colorHex ? { backgroundColor: colorHex } : undefined}
        aria-hidden="true"
      />
      <span className="jobs-usage__material-text">
        <strong>{name ?? 'Material'}</strong>
        {detail && <span className="mj-secondary"> {detail}</span>}
      </span>
      <Button kind="ghost" size="sm" onClick={onChange}>
        Change
      </Button>
    </div>
  );
}

function UsageRowFields({
  idPrefix,
  index,
  onRemove,
  onPick,
  canReadInventory,
  process,
}: {
  idPrefix: string;
  index: number;
  onRemove?: () => void;
  onPick: () => void;
  canReadInventory: boolean;
  process?: Process;
}) {
  const { control, setValue } = useFormContext<UsagesValues>();
  const row = useWatch({ control, name: `usages.${index}` });
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled: canReadInventory });
  const types = useQuery({ ...materialTypesQuery(), enabled: canReadInventory });
  const stockRow = row.ownership === 'makerspace' && !!row.materialId;
  const material = stockRow ? (materials.data?.items ?? []).find((item) => item.id === row.materialId) : undefined;
  const showSpools = stockRow && (!process || isFdm(process)) && (material ? material.kind === 'filament' : true);
  const spools = useQuery({
    ...spoolsQuery({ consumable: true, materialId: row.materialId, page: 1, pageSize: 100 }),
    enabled: canReadInventory && showSpools,
  });
  const type = row.ownership === 'external' ? types.data?.find((item) => item.id === row.materialTypeId) : undefined;
  const unit: MaterialUnit | undefined = material?.unit ?? type?.unit ?? row.unit;
  const spoolOptions = (spools.data?.items ?? []).map((spool) => ({
    id: spool.id,
    label: `${spool.displayId} · ${formatQuantity(spool.remainingQuantity)} ${unitText(spool.unit)} left`,
  }));
  if (row.spoolId && !spoolOptions.some((option) => option.id === row.spoolId))
    spoolOptions.unshift({ id: row.spoolId, label: row.spoolLabel ?? 'Current spool' });
  const chosen = hasMaterial(row);
  return (
    <div className="jobs-usage__row">
      <div className="jobs-usage__head">
        <span className="jobs-usage__number">Material {index + 1}</span>
        {onRemove && (
          <IconButton kind="ghost" size="sm" label="Remove material" align="left" onClick={onRemove}>
            <TrashCan />
          </IconButton>
        )}
      </div>
      <div
        className={
          showSpools && spoolOptions.length > 0 ? 'jobs-usage__line jobs-usage__line--spool' : 'jobs-usage__line'
        }
      >
        <div className="jobs-usage__field">
          <FormLabel id={`${idPrefix}-material-label`}>Material</FormLabel>
          {chosen ? (
            <SelectedMaterial
              row={row}
              colorHex={material?.colorHex}
              stock={material ? stockText(material) : undefined}
              onChange={onPick}
            />
          ) : (
            <Button
              kind="tertiary"
              size="md"
              renderIcon={Search}
              aria-describedby={`${idPrefix}-material-label`}
              disabled={!canReadInventory}
              onClick={onPick}
              data-guide="workshop-usage-select"
            >
              Select material
            </Button>
          )}
        </div>
        {showSpools && spoolOptions.length > 0 && (
          <Controller
            control={control}
            name={`usages.${index}.spoolId`}
            render={({ field }) => (
              <FuzzySelectField
                id={`${idPrefix}-spool`}
                titleText="Spool (optional)"
                placeholder="Loose stock"
                options={spoolOptions}
                value={field.value || null}
                onChange={(id) => {
                  field.onChange(id ?? '');
                  setValue(`usages.${index}.spoolLabel`, spoolOptions.find((option) => option.id === id)?.label, {
                    shouldDirty: true,
                  });
                }}
              />
            )}
          />
        )}
        <Controller
          control={control}
          name={`usages.${index}.quantity`}
          rules={{
            validate: (value, values) => {
              const current = values.usages[index];
              if (isBlankUsage(current)) return true;
              if (!hasMaterial(current)) return 'Select a material.';
              if (isExpression(value) && evaluateExpression(value) === null) return 'Check the calculation.';
              return decimalValidator({ positive: true, requiredMessage: 'Enter a quantity above zero.' })(
                resolveQuantityText(value),
              );
            },
          }}
          render={({ field: quantity, fieldState }) => {
            const result = isExpression(quantity.value) ? evaluateExpression(quantity.value) : null;
            return (
              <DecimalField
                id={`${idPrefix}-quantity`}
                labelText={unit ? `Quantity (${articleUnitLabel(unit, material?.countLabel)})` : 'Quantity'}
                value={quantity.value}
                disabled={!chosen}
                calculation
                placeholder={unit === 'cm2' || unit === 'm2' ? 'e.g. 20*30*2' : 'e.g. 12+3,5'}
                helperText={
                  !chosen
                    ? 'Select a material first.'
                    : result !== null
                      ? `= ${formatQuantity(resolveQuantityText(quantity.value), 6)}${unit ? ` ${unitSymbol(unit)}` : ''}`
                      : undefined
                }
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message ?? 'Enter a quantity above zero.'}
                onChange={quantity.onChange}
                onBlur={() => {
                  // A finished calculation becomes its result, so the row shows the quantity that is booked.
                  if (result !== null) quantity.onChange(resolveQuantityText(quantity.value));
                  quantity.onBlur();
                }}
              />
            );
          }}
        />
      </div>
    </div>
  );
}

/**
 * Material rows of a run. Each row picks its material in the catalog picker (stock article, optionally a spool, or
 * the recipient's own material) and takes the quantity here, also as a calculation such as 20*30*2.
 * `process` limits the catalog to the machine's process. `onPickingChange` tells the dialog to hide while the picker
 * is open. `single` edits exactly one row: no adding or removing.
 */
export function UsageRowsEditor({
  idPrefix,
  process,
  onPickingChange,
  single = false,
}: {
  idPrefix: string;
  process?: Process;
  onPickingChange?: (picking: boolean) => void;
  single?: boolean;
}) {
  const can = useCan();
  const canReadInventory = can('inventory.read');
  const { control, getValues, setValue } = useFormContext<UsagesValues>();
  const { fields, append, remove } = useFieldArray({ control, name: 'usages' });
  const [picking, setPicking] = useState<number | null>(null);
  useEffect(() => onPickingChange?.(picking !== null), [picking, onPickingChange]);
  const current = picking === null ? undefined : getValues(`usages.${picking}`);

  const pick = (index: number, picked: PickedMaterial) => {
    const previous = getValues(`usages.${index}`);
    const next: UsageRow =
      picked.kind === 'stock'
        ? {
            ...blankUsage(),
            quantity: previous.quantity,
            quantityBasis: previous.quantityBasis,
            materialId: picked.material.id,
            materialLabel: picked.material.name,
            materialTypeLabel: picked.material.materialTypeName,
            unit: picked.material.unit,
          }
        : {
            ...blankUsage(),
            quantity: previous.quantity,
            quantityBasis: previous.quantityBasis,
            ownership: 'external',
            externalName: picked.label,
            materialTypeId: picked.materialType?.id ?? '',
            materialTypeLabel: picked.materialType?.name,
            unit: picked.materialType?.unit,
          };
    setValue(`usages.${index}`, next, { shouldDirty: true });
    setPicking(null);
  };

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
      {fields.length === 0 && (
        <p className="mj-secondary">No material recorded. The run is priced for machine time only.</p>
      )}
      <div className="jobs-usage">
        {fields.map((field, index) => (
          <UsageRowFields
            key={field.id}
            idPrefix={`${idPrefix}-${index}`}
            index={index}
            canReadInventory={canReadInventory}
            process={process}
            onPick={() => setPicking(index)}
            onRemove={single ? undefined : () => remove(index)}
          />
        ))}
      </div>
      {!single && (
        <div>
          <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => append(blankUsage())}>
            Add material
          </Button>
        </div>
      )}
      <MaterialPickerModal
        open={picking !== null && canReadInventory}
        process={process}
        selectedMaterialId={current?.ownership === 'makerspace' ? current.materialId : undefined}
        own={
          current?.ownership === 'external'
            ? { label: current.externalName, materialTypeId: current.materialTypeId }
            : undefined
        }
        onClose={() => setPicking(null)}
        onPick={(picked) => {
          if (picking !== null) pick(picking, picked);
        }}
      />
    </Stack>
  );
}

function UsageForm({ onClose, run }: { onClose: () => void; run: MachineRun }) {
  const can = useCan();
  const association = useQuery({ ...jobOrderQuery(run.job?.id ?? ''), enabled: can('orders.read') && !!run.job });
  const machine = useQuery({ ...machineQuery(run.machineId), enabled: can('machines.read') });
  const process = machine.data?.process;
  // The form is built once the machine's process is known, so spool inputs only show for printers.
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
  process?: Process;
  association?: { orderId?: string | null; orderReference?: string | null };
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const form = useForm<UsagesValues>({
    defaultValues: { usages: run.usages.length ? usageRowsFromUsages(run.usages) : [blankUsage()] },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (values: UsagesValues) =>
      replaceMachineRunUsages(run.id, {
        usages: toUsageInputs(values.usages),
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
        open={!guard.dialogOpen && !picking}
        size="md"
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
                Saving replaces the full list of material consumed by this run; stock and the calculated price are
                updated. {run.source === 'recorded' && 'What the machine reported stays visible for reference. '}
                The recipient’s own material is never charged and never consumes stock.
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
              <UsageRowsEditor idPrefix="usage" process={process} onPickingChange={setPicking} />
            </Stack>
          </FormProvider>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={() => guard.requestDiscard(onClose)}>
            Cancel
          </Button>
          <Button kind="primary" disabled={pending} onClick={() => void submit()}>
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
