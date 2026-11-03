import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, MultiSelect, Select, SelectItem, Stack, TextInput, Toggle } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createMaterialType, updateMaterialType } from '../../../api/generated/inventory/inventory';
import type { MaterialKind, MaterialType, MaterialUnit, Process } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { typeNounLower } from '../components/inventoryShared';
import { machineLogbookKeys, processesQuery } from '../queries';
import { useCan } from '../shared/useCan';
import { useNotify } from '../shared/toasts';
import { useLatestCallback } from '../../../app/useLatestCallback';

type Values = {
  name: string;
  code: string;
  kind: MaterialKind;
  machineUse: boolean;
  unit: MaterialUnit;
  processIds: string[];
  active: boolean;
};

const kindLabels: Record<MaterialKind, string> = {
  filament: 'Filament (kept on spools)',
  consumable: 'Consumable (used on machines)',
  part: 'Part (sold or used as is)',
};

const materialUnits: MaterialUnit[] = ['g', 'm', 'ml', 'cm2', 'm2', 'piece'];
const unitNames: Record<MaterialUnit, string> = {
  g: 'Grams (g)',
  m: 'Metres (m)',
  ml: 'Millilitres (ml)',
  cm2: 'Square centimetres (cm²)',
  m2: 'Square metres (m²)',
  piece: 'Pieces (pcs)',
};

/**
 * Creates or edits a material type (a category for parts): the level a material price attaches to. A new type takes
 * its kind from `kind`. Filament is always measured in grams and keeps its processes; parts have no processes.
 */
export function MaterialTypeFormModal({
  open,
  onClose,
  materialType,
  kind: requestedKind = 'filament',
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  materialType?: MaterialType;
  kind?: MaterialKind;
  onDelete?: () => void;
}) {
  const initialKind = materialType?.kind ?? requestedKind;
  const noun = typeNounLower(initialKind);
  const can = useCan();
  // Without permission to read processes the list stays out and the type keeps the processes it has.
  const processesList = useQuery({
    ...processesQuery(),
    enabled: open && can('machines.read'),
  });
  const options = (processesList.data?.items ?? []).filter(
    (item) => item.active || materialType?.processIds.includes(item.id),
  );
  const client = useQueryClient();
  const notify = useNotify();
  const inUse = Boolean(materialType && (materialType.materialCount > 0 || materialType.pricingRuleCount > 0));
  const defaults = (): Values => ({
    name: materialType?.name ?? '',
    code: materialType?.code ?? '',
    kind: initialKind,
    machineUse: materialType?.machineUse ?? initialKind !== 'part',
    unit: materialType?.unit ?? (initialKind === 'filament' ? 'g' : 'piece'),
    processIds: materialType?.processIds ?? [],
    active: materialType?.active ?? true,
  });
  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
    watch,
  } = useForm<Values>({ defaultValues: defaults() });
  const kind = watch('kind');

  const save = useMutation({
    mutationFn: (values: Values) =>
      materialType
        ? updateMaterialType(materialType.id, {
            name: values.name.trim(),
            ...(values.code.trim() ? { code: values.code.trim().toUpperCase() } : {}),
            ...(values.kind !== materialType.kind ? { kind: values.kind } : {}),
            machineUse: values.kind === 'filament' || values.machineUse,
            unit: inUse || values.kind === 'filament' ? materialType.unit : values.unit,
            ...(kind === 'consumable' && processesList.isSuccess ? { processIds: values.processIds } : {}),
            active: values.active,
            expectedVersion: materialType.version,
          })
        : createMaterialType({
            name: values.name.trim(),
            ...(values.code.trim() ? { code: values.code.trim().toUpperCase() } : {}),
            kind: values.kind,
            machineUse: values.kind === 'filament' || values.machineUse,
            unit: values.kind === 'filament' ? 'g' : values.unit,
            ...(kind === 'consumable' && processesList.isSuccess ? { processIds: values.processIds } : {}),
          }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: materialType
          ? kind === 'part'
            ? 'Category saved'
            : 'Material type saved'
          : kind === 'part'
            ? 'Category added'
            : 'Material type added',
        subtitle: saved.name,
      });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && error.data?.code === 'material_type_exists')
        setError('name', { message: `A ${noun} with this name already exists.` });
      if (error instanceof ApiError && error.status === 409 && error.data?.code === 'material_type_code_exists')
        setError('code', { message: 'Another type uses this code.' });
    },
  });
  const resetForm = useLatestCallback(() => {
    reset(defaults());
    save.reset();
  });
  useEffect(() => {
    if (open) resetForm();
  }, [open, materialType?.id, resetForm]);
  const pending = save.isPending;
  const submit = handleSubmit((values) => {
    save.mutate(values);
  });
  const failure =
    save.error instanceof ApiError &&
    (save.error.data?.code === 'material_type_exists' || save.error.data?.code === 'material_type_code_exists')
      ? null
      : save.error;

  return (
    <Modal
      open={open}
      size="sm"
      modalHeading={materialType ? `Edit ${noun}` : `Add ${noun}`}
      primaryButtonText={pending ? 'Saving…' : materialType ? `Save ${noun}` : `Add ${noun}`}
      secondaryButtonText={materialType && onDelete ? 'Delete' : 'Cancel'}
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        void submit();
      }}
      onSecondarySubmit={() => {
        if (pending) return;
        if (materialType && onDelete) onDelete();
        else onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        <Stack gap={6}>
          <TextInput
            id="material-type-name"
            labelText="Name"
            autoComplete="off"
            helperText={
              kind === 'part'
                ? 'For example Fasteners, Bike or Electronics.'
                : kind === 'filament'
                  ? 'For example PLA, PETG or TPU 95A. Prices are set per material type.'
                  : 'For example Acrylic, Vinyl foil or Embroidery thread. Prices are set per material type.'
            }
            invalid={Boolean(errors.name)}
            invalidText={errors.name?.message}
            {...register('name', { validate: (value) => (value.trim() ? true : 'Enter a name.') })}
          />
          <TextInput
            id="material-type-code"
            labelText="Code (optional)"
            autoComplete="off"
            maxLength={12}
            helperText={
              materialType
                ? 'Used in new spool labels (S-CODE-…). Existing labels keep the old code.'
                : 'Used in spool labels (S-CODE-…). Defaults to the first word of the name.'
            }
            invalid={Boolean(errors.code)}
            invalidText={errors.code?.message}
            {...register('code', {
              validate: (value) =>
                !value.trim() || /^[A-Za-z0-9]{1,12}$/.test(value.trim()) || 'Use up to 12 letters or digits.',
              setValueAs: (value: string) => value.toUpperCase(),
            })}
          />
          <Select
            id="material-type-kind"
            labelText="Kind"
            disabled={Boolean(materialType && materialType.materialCount > 0)}
            helperText={
              materialType && materialType.materialCount > 0
                ? 'The kind cannot change while articles use this type.'
                : 'Decides the unit, the processes and whether stock is kept on spools.'
            }
            {...register('kind')}
          >
            {(['filament', 'consumable', 'part'] as MaterialKind[]).map((item) => (
              <SelectItem key={item} value={item} text={kindLabels[item]} />
            ))}
          </Select>
          <Controller
            control={control}
            name="machineUse"
            render={({ field }) => (
              <Toggle
                id="material-type-machine-use"
                labelText="Machine use"
                labelA="Not used in machine runs"
                labelB="Used in machine runs"
                disabled={kind === 'filament'}
                toggled={kind === 'filament' || field.value}
                onToggle={(checked) => field.onChange(checked)}
              />
            )}
          />
          <Select
            id="material-type-unit"
            labelText="Unit"
            disabled={inUse || kind === 'filament'}
            helperText={
              kind === 'filament'
                ? 'Filament is measured in grams.'
                : inUse
                  ? 'The unit cannot change while articles or pricing rules use this type.'
                  : 'Stock, consumption and the price of every article of this type use this unit.'
            }
            {...register('unit')}
          >
            {(kind === 'filament' ? (['g'] as MaterialUnit[]) : materialUnits).map((item) => (
              <SelectItem key={item} value={item} text={unitNames[item]} />
            ))}
          </Select>
          {kind === 'consumable' && processesList.isSuccess && (
            <Controller
              control={control}
              name="processIds"
              rules={{ validate: (value) => value.length > 0 || 'Choose at least one process.' }}
              render={({ field }) => (
                <MultiSelect<Process>
                  autoAlign
                  id="material-type-processes"
                  titleText="Used for processes"
                  label="Choose processes"
                  helperText="Manual runs only offer this material on machines of these processes."
                  invalid={Boolean(errors.processIds)}
                  invalidText={errors.processIds?.message}
                  items={options}
                  itemToString={(item) => item?.name ?? ''}
                  selectedItems={options.filter((item) => field.value.includes(item.id))}
                  onChange={({ selectedItems }) => field.onChange((selectedItems ?? []).map((item) => item.id))}
                />
              )}
            />
          )}
          {materialType && (
            <Controller
              control={control}
              name="active"
              render={({ field }) => (
                <Toggle
                  id="material-type-active"
                  labelText="Active"
                  labelA="Inactive"
                  labelB="Active"
                  toggled={field.value}
                  onToggle={(checked) => field.onChange(checked)}
                />
              )}
            />
          )}
          {failure && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title={`The ${noun} was not saved`}
              subtitle={failure instanceof ApiError ? failure.message : 'Try again.'}
            />
          )}
        </Stack>
      </form>
    </Modal>
  );
}
