import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, TextArea, TextInput } from '@carbon/react';
import { dateInAppTimeZone } from '../../../app/dateTime';
import { DateInput } from '../../../app/DateInput';
import { formatGrams, isFilament, looseStock, needsRefill, parseDecimal } from '../components/inventoryShared';
import { ProductPicker } from '../components/ProductPicker';
import { useSimulatedMutation, useStore } from '../store';
import type { FilamentProduct, Spool, SpoolKind, SpoolStockSource } from '../types';

type Values = {
  kind: SpoolKind; label: string; productId: string; manual: boolean; firstFill: 'fill' | 'empty'; materialId: string; weight: string; tare: string; manufacturer: string; product: string; location: string;
  source: SpoolStockSource; price: string; supplier: string; acquiredOn: string; reference: string; notes: string;
};

const nonNegative = (value: string) => !value.trim() || ((parseDecimal(value) ?? -1) >= 0) || 'Enter a number of zero or more.';

/** Registers a new spool, or edits the descriptive fields of an existing one. */
export function SpoolFormModal({ open, onClose, spool, materialId }: { open: boolean; onClose: () => void; spool?: Spool; materialId?: string }) {
  const store = useStore();
  const { mutate, pending } = useSimulatedMutation(store.saveSpool);
  const choices = store.materials.filter((material) => isFilament(material) && (material.active || material.id === (spool?.materialId ?? materialId)));
  // Registering offers the active catalog (of the material, when opened from a material page); editing keeps the snapshot text fields.
  const products = store.products.filter((product) => product.active && (!materialId || product.materialId === materialId)
    && store.materials.some((material) => material.id === product.materialId && material.active && isFilament(material)));
  const defaults = (): Values => ({
    kind: spool?.kind ?? 'reusable', label: spool?.label ?? '', productId: '', manual: Boolean(spool), firstFill: 'fill', materialId: spool?.materialId ?? materialId ?? '', weight: spool ? String(spool.initialNetWeightG) : '1000', tare: spool?.tareWeightG != null ? String(spool.tareWeightG) : '',
    manufacturer: spool?.manufacturer ?? '', product: spool?.productName ?? '', location: spool?.storageLocation ?? '',
    source: 'stock', price: '', supplier: '', acquiredOn: spool?.acquiredOn ?? dateInAppTimeZone(new Date()), reference: spool?.acquisitionReference ?? '', notes: spool?.notes ?? '',
  });
  const { control, register, handleSubmit, reset, watch, setValue, clearErrors, formState: { errors } } = useForm<Values>({ defaultValues: defaults() });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) reset(defaults()); }, [open, spool?.id, materialId]);
  const source = watch('source');
  const kind = watch('kind');
  const productId = watch('productId');
  const manual = watch('manual');
  const selectedProduct = products.find((item) => item.id === productId);
  const chooseProduct = (product: FilamentProduct | null) => {
    setValue('productId', product?.id ?? '', { shouldValidate: Boolean(product) });
    if (!product) return;
    setValue('materialId', product.materialId, { shouldValidate: true });
    setValue('weight', String(product.netWeightG));
    setValue('manufacturer', product.manufacturer);
    setValue('product', product.name);
    // The price is only used for a purchase; it stays editable.
    setValue('price', product.defaultPrice != null ? String(product.defaultPrice) : '');
    setValue('kind', product.packaging === 'spool' ? 'single_use' : 'reusable');
  };
  const setManual = (next: boolean) => {
    setValue('manual', next);
    if (next) { setValue('productId', ''); clearErrors('productId'); }
  };
  // Reusable spools can be registered empty; an existing spool without a current fill has nothing to edit about it.
  const showFill = spool ? !needsRefill(spool) : kind === 'single_use' || watch('firstFill') === 'fill';
  const selectedMaterial = store.materials.find((material) => material.id === watch('materialId'));
  const available = selectedMaterial ? looseStock(selectedMaterial, store.spools) : 0;
  const typedWeight = parseDecimal(watch('weight')) ?? 0;
  const effect = !selectedMaterial ? undefined : source === 'stock'
    ? `Moves ${formatGrams(typedWeight)} from loose stock to this spool. The material total stays ${formatGrams(selectedMaterial.quantity)}.`
    : `Adds ${formatGrams(typedWeight)} to ${selectedMaterial.name} stock (new total ${formatGrams(selectedMaterial.quantity + typedWeight)}) and records the purchase.`;

  const submit = handleSubmit(async (values) => {
    const saved = await mutate({
      id: spool?.id, kind: values.kind, label: values.label.trim() || null, withFill: showFill, materialId: values.materialId, initialNetWeightG: parseDecimal(values.weight) ?? 0, tareWeightG: parseDecimal(values.tare),
      productId: spool ? spool.productId : values.manual ? null : values.productId || null,
      manufacturer: values.manufacturer.trim() || null, productName: values.product.trim() || null, storageLocation: values.location.trim() || null,
      acquiredOn: values.acquiredOn, acquisitionReference: values.reference.trim() || null, notes: values.notes.trim() || null,
      source: values.source, purchasePrice: values.source === 'purchase' ? parseDecimal(values.price) : null, supplier: values.supplier.trim() || null,
    });
    store.notify({ kind: 'success', title: spool ? 'Spool saved' : 'Spool registered', subtitle: `${saved.displayId} · ${saved.materialName}` });
    onClose();
  });

  return (
    <Modal
      open={open} size="md" modalHeading={spool ? `Edit ${spool.displayId}` : 'Register spool'}
      primaryButtonText={pending ? 'Saving…' : spool ? 'Save spool' : 'Register spool'} secondaryButtonText="Cancel" primaryButtonDisabled={pending}
      preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <Stack gap={6}>
          {choices.length === 0 && !spool && <InlineNotification kind="warning" lowContrast hideCloseButton title="No filament materials" subtitle="Add a material in the Filament category first." />}
          <Controller
            control={control} name="kind"
            render={({ field }) => (
              <RadioButtonGroup legendText="Type" name="spool-kind" orientation="vertical" valueSelected={field.value} disabled={Boolean(spool)}
                helperText={field.value === 'reusable' ? 'Refilled many times, e.g. a Bambu spool whose NFC tag changes with every refill.' : 'Archived when finished; old archived spools can be cleaned up.'}
                onChange={(value) => field.onChange(value)}>
                <RadioButton id="spool-kind-reusable" value="reusable" labelText="Reusable" />
                <RadioButton id="spool-kind-single" value="single_use" labelText="Single-use" />
              </RadioButtonGroup>
            )}
          />
          <TextInput id="spool-label" labelText="Label (optional)" helperText="For example Bambu spool 03." autoComplete="off" {...register('label')} />
          {!spool && kind === 'reusable' && (
            <Controller
              control={control} name="firstFill"
              render={({ field }) => (
                <RadioButtonGroup legendText="First fill" name="spool-first-fill" orientation="vertical" valueSelected={field.value} onChange={(value) => field.onChange(value)}>
                  <RadioButton id="spool-first-fill-yes" value="fill" labelText="With a first fill" />
                  <RadioButton id="spool-first-fill-no" value="empty" labelText="Register empty and fill later (Change filament)" />
                </RadioButtonGroup>
              )}
            />
          )}
          {showFill && !spool && (
            <Controller
              control={control} name="productId" rules={{ validate: (value, form) => form.manual || Boolean(value) || 'Choose a product, or select Not in catalog.' }}
              render={({ fieldState }) => (
                <ProductPicker
                  id="spool-product-picker" products={products} materials={store.materials} productId={productId} manual={manual}
                  onProduct={chooseProduct} onManual={setManual} invalid={fieldState.invalid} invalidText={fieldState.error?.message}
                />
              )}
            />
          )}
          {showFill && selectedProduct && <TextInput id="spool-material-product" labelText="Material" readOnly value={selectedMaterial?.name ?? ''} helperText="Set by the product." />}
          {showFill && !selectedProduct && <Select
            id="spool-material" labelText="Material" disabled={Boolean(spool)} helperText={spool ? 'The material of a registered spool cannot change.' : undefined}
            invalid={Boolean(errors.materialId)} invalidText={errors.materialId?.message} {...register('materialId', { validate: (value) => !showFill || Boolean(value) || 'Choose a material.' })}
          >
            <SelectItem value="" text="Choose a material" />
            {choices.map((material) => <SelectItem key={material.id} value={material.id} text={material.active ? material.name : `${material.name} (inactive)`} />)}
          </Select>}
          {showFill && <TextInput
            id="spool-weight" labelText="Initial net weight (g)" inputMode="decimal" autoComplete="off" disabled={Boolean(spool)}
            helperText={spool ? 'Corrections change the remaining weight; the initial weight stays.' : 'Filament weight without the spool.'}
            invalid={Boolean(errors.weight)} invalidText={errors.weight?.message}
            {...register('weight', {
              validate: (value) => {
                if (!showFill) return true;
                const weight = parseDecimal(value);
                if (weight == null || weight <= 0) return 'Enter a weight above zero.';
                return !spool && source === 'stock' && weight > available ? `Only ${formatGrams(available)} of loose stock is available.` : true;
              },
            })}
          />}
          <TextInput id="spool-tare" labelText="Tare weight in g (optional)" helperText="Empty spool, for weighing." inputMode="decimal" autoComplete="off" invalid={Boolean(errors.tare)} invalidText={errors.tare?.message} {...register('tare', { validate: nonNegative })} />
          {showFill && manual && <TextInput id="spool-manufacturer" labelText="Manufacturer (optional)" autoComplete="off" {...register('manufacturer')} />}
          {showFill && manual && <TextInput id="spool-product" labelText="Product (optional)" autoComplete="off" {...register('product')} />}
          <TextInput id="spool-location" labelText="Storage location (optional)" autoComplete="off" {...register('location')} />
          {!spool && showFill && (
            <>
              <Controller
                control={control} name="source"
                render={({ field }) => (
                  <RadioButtonGroup legendText="Stock source" name="spool-source" orientation="vertical" valueSelected={field.value} helperText={effect} onChange={(value) => field.onChange(value)}>
                    <RadioButton id="spool-source-stock" value="stock" labelText={`Taken from loose stock${selectedMaterial ? ` (${formatGrams(available)} available)` : ''}`} />
                    <RadioButton id="spool-source-purchase" value="purchase" labelText="Bought as a spool" />
                  </RadioButtonGroup>
                )}
              />
              {source === 'purchase' && (
                <>
                  <TextInput id="spool-price" labelText="Purchase price in EUR (optional)" inputMode="decimal" autoComplete="off" invalid={Boolean(errors.price)} invalidText={errors.price?.message} {...register('price', { validate: nonNegative })} />
                  <TextInput id="spool-supplier" labelText="Supplier (optional)" autoComplete="off" {...register('supplier')} />
                </>
              )}
            </>
          )}
          <Controller
            control={control} name="acquiredOn" rules={{ required: 'Enter the acquisition date.' }}
            render={({ field, fieldState }) => (
              <DateInput id="spool-acquired" labelText="Acquired on" value={field.value} onChange={field.onChange} invalid={fieldState.invalid} invalidText={fieldState.error?.message} required />
            )}
          />
          <TextInput id="spool-reference" labelText="Acquisition reference (optional)" helperText="Invoice or order number." autoComplete="off" {...register('reference')} />
          <TextArea id="spool-notes" labelText="Notes (optional)" rows={3} {...register('notes')} />
        </Stack>
      </form>
    </Modal>
  );
}
