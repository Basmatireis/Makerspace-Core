import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Modal, Select, SelectItem, Stack, TextInput, Toggle } from '@carbon/react';
import { parseDecimal, unitLabel } from '../components/inventoryShared';
import { useSimulatedMutation, useStore } from '../store';
import type { Material, MaterialUnit } from '../types';

type Values = { name: string; category: string; unit: MaterialUnit; color: string; diameter: string; threshold: string; active: boolean };

const units: MaterialUnit[] = ['g', 'ml', 'pcs', 'm2'];
const unitNames: Record<MaterialUnit, string> = { g: 'Grams (g)', ml: 'Millilitres (ml)', pcs: 'Pieces (pcs)', m2: 'Square metres (m²)' };
const optionalNumber = (value: string) => !value.trim() || (parseDecimal(value) != null && (parseDecimal(value) ?? 0) >= 0) || 'Enter a number of zero or more.';

export function MaterialFormModal({ open, onClose, material }: { open: boolean; onClose: () => void; material?: Material }) {
  const store = useStore();
  const { mutate, pending } = useSimulatedMutation(store.saveMaterial);
  const hasStock = Boolean(material && (material.quantity > 0 || store.spools.some((spool) => spool.materialId === material.id)));
  const defaults = (): Values => ({
    name: material?.name ?? '', category: material?.category ?? '', unit: material?.unit ?? 'g', color: material?.color ?? '',
    diameter: material?.diameterMm != null ? String(material.diameterMm) : '', threshold: material?.lowStockThreshold != null ? String(material.lowStockThreshold) : '',
    active: material?.active ?? true,
  });
  const { control, register, handleSubmit, reset, watch, formState: { errors } } = useForm<Values>({ defaultValues: defaults() });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) reset(defaults()); }, [open, material?.id]);
  const unit = watch('unit');

  const submit = handleSubmit(async (values) => {
    const saved = await mutate({
      id: material?.id, name: values.name.trim(), category: values.category.trim(), unit: values.unit, color: values.color.trim() || null,
      diameterMm: parseDecimal(values.diameter), lowStockThreshold: parseDecimal(values.threshold), active: values.active,
    });
    store.notify({ kind: 'success', title: material ? 'Material saved' : 'Material added', subtitle: saved.name });
    onClose();
  });

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
            id="material-threshold" labelText={`Low-stock threshold in ${unitLabel(unit)} (optional)`} helperText="Stock at or below this quantity is flagged as low." inputMode="decimal" autoComplete="off"
            invalid={Boolean(errors.threshold)} invalidText={errors.threshold?.message} {...register('threshold', { validate: optionalNumber })}
          />
          <Controller
            control={control} name="active"
            render={({ field }) => (
              <Toggle id="material-active" labelText="Active" labelA="Inactive" labelB="Active" toggled={field.value} onToggle={(checked) => field.onChange(checked)} />
            )}
          />
        </Stack>
      </form>
    </Modal>
  );
}
