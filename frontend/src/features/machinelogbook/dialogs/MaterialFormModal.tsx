import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, Select, SelectItem, Stack, TextInput, Toggle } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createMaterial, updateMaterial } from '../../../api/generated/inventory/inventory';
import type { Material, MaterialUnit } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { parseDecimal, toDecimal, unitLabel } from '../components/inventoryShared';
import { machineLogbookKeys } from '../queries';
import { useNotify } from '../shared/toasts';

type Values = { name: string; category: string; unit: MaterialUnit; color: string; diameter: string; threshold: string; active: boolean };

const units: MaterialUnit[] = ['g', 'm', 'ml', 'm2', 'piece'];
const unitNames: Record<MaterialUnit, string> = { g: 'Grams (g)', m: 'Metres (m)', ml: 'Millilitres (ml)', m2: 'Square metres (m²)', piece: 'Pieces (pcs)' };
const optionalNumber = (value: string) => !value.trim() || (parseDecimal(value) != null && (parseDecimal(value) ?? 0) >= 0) || 'Enter a number of zero or more.';
const optionalDecimal = (value: string) => { const parsed = parseDecimal(value); return parsed == null ? null : toDecimal(parsed); };

export function MaterialFormModal({ open, onClose, material }: { open: boolean; onClose: () => void; material?: Material }) {
  const client = useQueryClient();
  const notify = useNotify();
  const hasStock = Boolean(material && Number(material.quantity) > 0);
  const defaults = (): Values => ({
    name: material?.name ?? '', category: material?.category ?? '', unit: material?.unit ?? 'g', color: material?.color ?? '',
    diameter: material?.filamentDiameterMm != null ? String(Number(material.filamentDiameterMm)) : '', threshold: material?.lowStockThreshold != null ? String(Number(material.lowStockThreshold)) : '',
    active: material?.active ?? true,
  });
  const { control, register, handleSubmit, reset, watch, setError, formState: { errors } } = useForm<Values>({ defaultValues: defaults() });
  const unit = watch('unit');

  const save = useMutation({
    mutationFn: (values: Values) => {
      const input = {
        name: values.name.trim(), category: values.category.trim(), unit: hasStock && material ? material.unit : values.unit, color: values.color.trim() || null,
        lowStockThreshold: optionalDecimal(values.threshold), filamentDiameterMm: optionalDecimal(values.diameter),
      };
      return material ? updateMaterial(material.id, { ...input, active: values.active, expectedVersion: material.version }) : createMaterial(input);
    },
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({ kind: 'success', title: material ? 'Material saved' : 'Material added', subtitle: saved.name });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && error.data?.code === 'already_exists') setError('name', { message: 'A material with this name already exists.' });
    },
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { reset(defaults()); save.reset(); } }, [open, material?.id]);
  const pending = save.isPending;
  const submit = handleSubmit((values) => { save.mutate(values); });
  const failure = save.error instanceof ApiError && save.error.data?.code === 'already_exists' ? null : save.error;

  return (
    <Modal
      open={open} size="sm" modalHeading={material ? 'Edit material' : 'Add material'}
      primaryButtonText={pending ? 'Saving…' : material ? 'Save material' : 'Add material'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending} preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <Stack gap={6}>
          <TextInput
            id="material-name" labelText="Name" autoComplete="off" invalid={Boolean(errors.name)} invalidText={errors.name?.message}
            {...register('name', { validate: (value) => value.trim() ? true : 'Enter a material name.' })}
          />
          <TextInput
            id="material-category" labelText="Category" helperText="For example Filament, Resin or Sheet. Filament is tracked per spool." autoComplete="off"
            invalid={Boolean(errors.category)} invalidText={errors.category?.message}
            {...register('category', { validate: (value) => value.trim() ? true : 'Enter a category.' })}
          />
          <Select
            id="material-unit" labelText="Unit" disabled={hasStock}
            helperText={hasStock ? 'The unit cannot change while stock or spools exist.' : 'Stock, prices and consumption use this unit.'}
            {...register('unit')}
          >
            {units.map((item) => <SelectItem key={item} value={item} text={unitNames[item]} />)}
          </Select>
          <TextInput id="material-color" labelText="Colour (optional)" autoComplete="off" {...register('color')} />
          <TextInput
            id="material-diameter" labelText="Filament diameter in mm (optional)" helperText="For example 1.75." inputMode="decimal" autoComplete="off"
            invalid={Boolean(errors.diameter)} invalidText={errors.diameter?.message} {...register('diameter', { validate: optionalNumber })}
          />
          <TextInput
            id="material-threshold" labelText={`Low-stock threshold in ${unitLabel(hasStock && material ? material.unit : unit)} (optional)`} helperText="Stock at or below this quantity is flagged as low." inputMode="decimal" autoComplete="off"
            invalid={Boolean(errors.threshold)} invalidText={errors.threshold?.message} {...register('threshold', { validate: optionalNumber })}
          />
          {material && (
            <Controller
              control={control} name="active"
              render={({ field }) => (
                <Toggle id="material-active" labelText="Active" labelA="Inactive" labelB="Active" toggled={field.value} onToggle={(checked) => field.onChange(checked)} />
              )}
            />
          )}
          {failure && <InlineNotification kind="error" lowContrast hideCloseButton title="The material was not saved" subtitle={failure instanceof ApiError ? failure.message : 'Try again.'} />}
        </Stack>
      </form>
    </Modal>
  );
}
