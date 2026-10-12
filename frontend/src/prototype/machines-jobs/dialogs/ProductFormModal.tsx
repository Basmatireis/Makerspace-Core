import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ComboBox, InlineNotification, Modal, NumberInput, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, TextArea, TextInput, Toggle } from '@carbon/react';
import { isFilament } from '../components/inventoryShared';
import { useSimulatedMutation, useStore } from '../store';
import type { FilamentPackaging, FilamentProduct } from '../types';

type Values = {
  manufacturer: string; name: string; materialId: string; netWeight: number | ''; price: number | ''; packaging: FilamentPackaging; notes: string; active: boolean;
};

/** Adds or edits a catalog product (future backend capability, needs `inventory.manage`). */
export function ProductFormModal({ open, onClose, product, materialId }: { open: boolean; onClose: () => void; product?: FilamentProduct; materialId?: string }) {
  const store = useStore();
  const { mutate, pending } = useSimulatedMutation(store.saveProduct);
  const choices = store.materials.filter((material) => isFilament(material) && (material.active || material.id === product?.materialId));
  const manufacturers = [...new Set(store.products.map((item) => item.manufacturer))].sort((a, b) => a.localeCompare(b));
  const defaults = (): Values => ({
    manufacturer: product?.manufacturer ?? '', name: product?.name ?? '', materialId: product?.materialId ?? materialId ?? '', netWeight: product?.netWeightG ?? 1000,
    price: product?.defaultPrice ?? '', packaging: product?.packaging ?? 'spool', notes: product?.notes ?? '', active: product?.active ?? true,
  });
  const { control, register, handleSubmit, reset, watch, formState: { errors } } = useForm<Values>({ defaultValues: defaults() });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) reset(defaults()); }, [open, product?.id, materialId]);
  const packaging = watch('packaging');

  const submit = handleSubmit(async (values) => {
    const saved = await mutate({
      id: product?.id, manufacturer: values.manufacturer.trim(), name: values.name.trim(), materialId: values.materialId, netWeightG: Number(values.netWeight),
      defaultPrice: values.price === '' ? null : Number(values.price), packaging: values.packaging, notes: values.notes.trim() || null, active: product ? values.active : true,
    });
    store.notify({ kind: 'success', title: product ? 'Product saved' : 'Product added', subtitle: `${saved.manufacturer} · ${saved.name}` });
    onClose();
  });

  return (
    <Modal
      open={open} size="md" modalHeading={product ? 'Edit product' : 'Add product'}
      primaryButtonText={pending ? 'Saving…' : product ? 'Save product' : 'Add product'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || !store.can('inventory.manage')} preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <Stack gap={6}>
          {!store.can('inventory.manage') && <InlineNotification kind="warning" lowContrast hideCloseButton title="No permission" subtitle="Changing the product catalog needs the inventory.manage permission." />}
          <Controller
            control={control} name="manufacturer" rules={{ validate: (value) => value.trim() ? true : 'Enter a manufacturer.' }}
            render={({ field, fieldState }) => (
              <ComboBox<string>
                key={`${open}-${product?.id ?? 'new'}`} id="product-manufacturer" titleText="Manufacturer" placeholder="Choose or type a manufacturer" items={manufacturers} allowCustomValue
                helperText="Pick an existing manufacturer or type a new one." itemToString={(item) => item ?? ''} initialSelectedItem={defaults().manufacturer || undefined}
                onInputChange={(value) => field.onChange(value ?? '')} onChange={({ selectedItem }) => field.onChange(selectedItem ?? '')}
                invalid={fieldState.invalid} invalidText={fieldState.error?.message}
              />
            )}
          />
          <TextInput
            id="product-name" labelText="Product" helperText="For example PLA Basic Black." autoComplete="off" invalid={Boolean(errors.name)} invalidText={errors.name?.message}
            {...register('name', {
              validate: (value, form) => {
                if (!value.trim()) return 'Enter a product name.';
                const duplicate = store.products.some((item) => item.id !== product?.id && item.manufacturer.trim().toLowerCase() === form.manufacturer.trim().toLowerCase() && item.name.trim().toLowerCase() === value.trim().toLowerCase());
                return duplicate ? 'This manufacturer already has a product with this name.' : true;
              },
            })}
          />
          <Select
            id="product-material" labelText="Material" helperText="The stock that bought grams count towards. Its category drives job pricing."
            invalid={Boolean(errors.materialId)} invalidText={errors.materialId?.message}
            {...register('materialId', { required: 'Choose a material.' })}
          >
            <SelectItem value="" text="Choose a material" />
            {choices.map((material) => <SelectItem key={material.id} value={material.id} text={material.active ? material.name : `${material.name} (inactive)`} />)}
          </Select>
          <Controller
            control={control} name="netWeight" rules={{ validate: (value) => (value !== '' && Number(value) > 0) || 'Enter a weight above zero.' }}
            render={({ field, fieldState }) => (
              <NumberInput
                id="product-weight" label="Net weight (g)" helperText="Filament without the spool." allowEmpty min={0} step={50} hideSteppers
                value={field.value} invalid={fieldState.invalid} invalidText={fieldState.error?.message} onChange={(_event, state) => field.onChange(state.value === '' ? '' : Number(state.value))}
              />
            )}
          />
          <Controller
            control={control} name="price" rules={{ validate: (value) => value === '' || Number(value) >= 0 || 'Enter a price of zero or more.' }}
            render={({ field, fieldState }) => (
              <NumberInput
                id="product-price" label="Default price (€, optional)" helperText={`Per ${packaging === 'refill' ? 'refill' : 'spool'} bought. Prefilled for a new purchase.`} allowEmpty min={0} step={0.5} hideSteppers
                value={field.value} invalid={fieldState.invalid} invalidText={fieldState.error?.message} onChange={(_event, state) => field.onChange(state.value === '' ? '' : Number(state.value))}
              />
            )}
          />
          <Controller
            control={control} name="packaging"
            render={({ field }) => (
              <RadioButtonGroup legendText="Packaging" name="product-packaging" orientation="vertical" valueSelected={field.value} onChange={(value) => field.onChange(value)}>
                <RadioButton id="product-packaging-refill" value="refill" labelText="Refill — filament only, for reusable spools" />
                <RadioButton id="product-packaging-spool" value="spool" labelText="Spool — comes on its own single-use spool" />
              </RadioButtonGroup>
            )}
          />
          <TextArea id="product-notes" labelText="Notes (optional)" rows={3} {...register('notes')} />
          {product && (
            <Controller
              control={control} name="active"
              render={({ field }) => (
                <Toggle
                  id="product-active" labelText="Active" labelA="Inactive" labelB="Active" toggled={field.value}
                  onToggle={(checked) => field.onChange(checked)}
                />
              )}
            />
          )}
        </Stack>
      </form>
    </Modal>
  );
}
