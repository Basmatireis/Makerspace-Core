import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, Select, SelectItem, Stack, TextInput, Toggle } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createMaterialType, updateMaterialType } from '../../../api/generated/inventory/inventory';
import type { MaterialType, MaterialUnit } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';

type Values = { name: string; unit: MaterialUnit; active: boolean };

const materialUnits: MaterialUnit[] = ['g', 'm', 'ml', 'm2', 'piece'];
const unitNames: Record<MaterialUnit, string> = { g: 'Grams (g)', m: 'Metres (m)', ml: 'Millilitres (ml)', m2: 'Square metres (m²)', piece: 'Pieces (pcs)' };

/** Creates or edits a material type: the level a material price attaches to. */
export function MaterialTypeFormModal({ open, onClose, materialType, onDelete }: { open: boolean; onClose: () => void; materialType?: MaterialType; onDelete?: () => void }) {
  const client = useQueryClient();
  const notify = useNotify();
  const inUse = Boolean(materialType && (materialType.materialCount > 0 || materialType.pricingRuleCount > 0));
  const defaults = (): Values => ({ name: materialType?.name ?? '', unit: materialType?.unit ?? 'g', active: materialType?.active ?? true });
  const { control, register, handleSubmit, reset, setError, formState: { errors } } = useForm<Values>({ defaultValues: defaults() });

  const save = useMutation({
    mutationFn: (values: Values) => materialType
      ? updateMaterialType(materialType.id, { name: values.name.trim(), unit: inUse ? materialType.unit : values.unit, active: values.active, expectedVersion: materialType.version })
      : createMaterialType({ name: values.name.trim(), unit: values.unit }),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: materialType ? 'Material type saved' : 'Material type added', subtitle: saved.name });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && error.data?.code === 'material_type_exists') setError('name', { message: 'A material type with this name already exists.' });
    },
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { reset(defaults()); save.reset(); } }, [open, materialType?.id]);
  const pending = save.isPending;
  const submit = handleSubmit((values) => { save.mutate(values); });
  const failure = save.error instanceof ApiError && save.error.data?.code === 'material_type_exists' ? null : save.error;

  return (
    <Modal
      open={open} size="sm" modalHeading={materialType ? 'Edit material type' : 'Add material type'}
      primaryButtonText={pending ? 'Saving…' : materialType ? 'Save material type' : 'Add material type'} secondaryButtonText={materialType && onDelete ? 'Delete' : 'Cancel'}
      primaryButtonDisabled={pending} preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
      onSecondarySubmit={() => { if (pending) return; if (materialType && onDelete) onDelete(); else onClose(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <Stack gap={6}>
          <TextInput
            id="material-type-name" labelText="Name" helperText="For example PLA, PETG or TPU 95A. Prices are set per material type." autoComplete="off"
            invalid={Boolean(errors.name)} invalidText={errors.name?.message}
            {...register('name', { validate: (value) => value.trim() ? true : 'Enter a name.' })}
          />
          <Select
            id="material-type-unit" labelText="Unit" disabled={inUse}
            helperText={inUse ? 'The unit cannot change while materials or pricing rules use this type.' : 'Stock, consumption and the price of every material of this type use this unit.'}
            {...register('unit')}
          >
            {materialUnits.map((item) => <SelectItem key={item} value={item} text={unitNames[item]} />)}
          </Select>
          {materialType && (
            <Controller
              control={control} name="active"
              render={({ field }) => (
                <Toggle id="material-type-active" labelText="Active" labelA="Inactive" labelB="Active" toggled={field.value} onToggle={(checked) => field.onChange(checked)} />
              )}
            />
          )}
          {failure && <InlineNotification kind="error" lowContrast hideCloseButton title="The material type was not saved" subtitle={failure instanceof ApiError ? failure.message : 'Try again.'} />}
        </Stack>
      </form>
    </Modal>
  );
}
