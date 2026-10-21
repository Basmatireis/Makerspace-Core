import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  Checkbox,
  CheckboxGroup,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  TextInput,
  Toggle,
} from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createMaterialType, updateMaterialType } from '../../../api/generated/inventory/inventory';
import type { MachineProcess, MaterialKind, MaterialType, MaterialUnit } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { typeNounLower } from '../components/inventoryShared';
import { processOptions } from '../processConfig';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';
import { useLatestCallback } from '../../../app/useLatestCallback';

type Values = { name: string; unit: MaterialUnit; processes: MachineProcess[]; active: boolean };

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
  const kind = materialType?.kind ?? requestedKind;
  const noun = typeNounLower(kind);
  const options =
    kind === 'consumable' ? processOptions.filter((option) => option.id !== 'fdm_printing') : processOptions;
  const client = useQueryClient();
  const notify = useNotify();
  const inUse = Boolean(materialType && (materialType.materialCount > 0 || materialType.pricingRuleCount > 0));
  const defaults = (): Values => ({
    name: materialType?.name ?? '',
    unit: materialType?.unit ?? (kind === 'filament' ? 'g' : 'piece'),
    processes: materialType?.processes ?? (kind === 'consumable' ? ['other'] : []),
    active: materialType?.active ?? true,
  });
  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<Values>({ defaultValues: defaults() });

  const save = useMutation({
    mutationFn: (values: Values) =>
      materialType
        ? updateMaterialType(materialType.id, {
            name: values.name.trim(),
            unit: inUse || kind === 'filament' ? materialType.unit : values.unit,
            ...(kind === 'consumable' ? { processes: values.processes } : {}),
            active: values.active,
            expectedVersion: materialType.version,
          })
        : createMaterialType({
            name: values.name.trim(),
            kind,
            unit: kind === 'filament' ? 'g' : values.unit,
            ...(kind === 'consumable' ? { processes: values.processes } : {}),
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
    save.error instanceof ApiError && save.error.data?.code === 'material_type_exists' ? null : save.error;

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
          {kind === 'consumable' && (
            <Controller
              control={control}
              name="processes"
              rules={{ validate: (value) => value.length > 0 || 'Choose at least one process.' }}
              render={({ field }) => (
                <CheckboxGroup
                  legendText="Used for processes"
                  helperText="Manual runs only offer this material on machines of these processes."
                  invalid={Boolean(errors.processes)}
                  invalidText={errors.processes?.message}
                >
                  {options.map((option) => (
                    <Checkbox
                      key={option.id}
                      id={`material-type-process-${option.id}`}
                      labelText={option.label}
                      checked={field.value.includes(option.id)}
                      onChange={(_event, { checked }) =>
                        field.onChange(
                          checked ? [...field.value, option.id] : field.value.filter((item) => item !== option.id),
                        )
                      }
                    />
                  ))}
                </CheckboxGroup>
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
