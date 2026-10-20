import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { createFilamentSpool, updateFilamentSpool } from '../../../api/generated/filament-spools/filament-spools';
import type {
  CreateFilamentSpoolRequestStockMode,
  FilamentProduct,
  FilamentSpool,
  FilamentSpoolKind,
} from '../../../api/generated/models';
import { dateInAppTimeZone } from '../../../app/dateTime';
import { DateInput } from '../../../app/DateInput';
import { ProductPicker } from '../components/ProductPicker';
import { formatGrams, parseDecimal, toDecimal } from '../components/inventoryShared';
import { hasOpenFill, toNumber } from '../components/spoolShared';
import { useNotify } from '../shared/toasts';
import {
  activeProductsQuery,
  filamentMaterialsQuery,
  spoolErrorMessage,
  spoolUpdateBody,
  useRefreshInventory,
} from '../spoolData';
import { useLatestCallback } from '../../../app/useLatestCallback';

type Values = {
  kind: FilamentSpoolKind;
  label: string;
  productId: string;
  manual: boolean;
  materialId: string;
  weight: string;
  tare: string;
  manufacturer: string;
  product: string;
  location: string;
  firstFill: 'fill' | 'empty';
  source: Exclude<CreateFilamentSpoolRequestStockMode, 'empty'>;
  price: string;
  supplier: string;
  acquiredOn: string;
  reference: string;
  notes: string;
};

const nonNegative = (value: string) =>
  !value.trim() || (parseDecimal(value) ?? -1) >= 0 || 'Enter a number of zero or more.';
const orNull = (value: string) => value.trim() || null;

/** Registers a new spool with its first fill, or edits the descriptive fields of an existing one. */
export function SpoolFormModal({
  open,
  onClose,
  spool,
  initialMaterialId,
}: {
  open: boolean;
  onClose: () => void;
  spool?: FilamentSpool;
  initialMaterialId?: string;
}) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const materials = useQuery({ ...filamentMaterialsQuery(), enabled: open });
  const catalog = useQuery({ ...activeProductsQuery(), enabled: open && !spool });
  const keptMaterialId = spool?.materialId ?? initialMaterialId;
  const choices = (materials.data ?? []).filter((material) => material.active || material.id === keptMaterialId);
  // Registering offers the active catalog (of the material, when opened from a material page); editing keeps the snapshot text fields.
  const products = (catalog.data ?? []).filter(
    (product) =>
      (!initialMaterialId || product.materialId === initialMaterialId) &&
      (materials.data ?? []).some((material) => material.id === product.materialId && material.active),
  );
  const defaults = (): Values => ({
    kind: spool?.kind ?? 'reusable',
    label: spool?.label ?? '',
    productId: '',
    manual: Boolean(spool),
    materialId: spool?.materialId ?? initialMaterialId ?? '',
    weight: spool ? String(toNumber(spool.initialNetWeightG)) : '1000',
    tare: spool?.tareWeightG != null ? String(toNumber(spool.tareWeightG)) : '',
    manufacturer: spool?.manufacturer ?? '',
    product: spool?.productName ?? '',
    location: spool?.storageLocation ?? '',
    firstFill: 'fill',
    source: 'existing_stock',
    price: '',
    supplier: '',
    acquiredOn: spool?.acquiredOn ?? dateInAppTimeZone(new Date()),
    reference: spool?.acquisitionReference ?? '',
    notes: spool?.notes ?? '',
  });
  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    clearErrors,
    formState: { errors },
  } = useForm<Values>({ defaultValues: defaults() });
  // Reusable spools can be registered empty; an existing spool without a current fill has nothing to edit about a fill.
  const showFill = spool ? hasOpenFill(spool) : watch('kind') === 'single_use' || watch('firstFill') === 'fill';
  const mutation = useMutation({
    mutationFn: (values: Values) => {
      if (spool) {
        const tare = parseDecimal(values.tare);
        return updateFilamentSpool(
          spool.id,
          spoolUpdateBody(spool, {
            label: orNull(values.label),
            tareWeightG: tare == null ? null : toDecimal(tare),
            // The snapshot belongs to the open fill; a spool waiting for a refill has none to edit.
            ...(hasOpenFill(spool)
              ? { manufacturer: orNull(values.manufacturer), productName: orNull(values.product) }
              : {}),
            storageLocation: orNull(values.location),
            acquiredOn: values.acquiredOn || null,
            acquisitionReference: orNull(values.reference),
            notes: orNull(values.notes),
          }),
        );
      }
      const tare = parseDecimal(values.tare);
      if (!showFill) {
        // A reusable spool registered without a fill; Change filament starts its first fill later.
        return createFilamentSpool({
          kind: 'reusable',
          label: orNull(values.label),
          stockMode: 'empty',
          tareWeightG: tare == null ? null : toDecimal(tare),
          acquiredOn: values.acquiredOn || null,
          acquisitionReference: orNull(values.reference),
          storageLocation: orNull(values.location),
          notes: orNull(values.notes),
          occurredAt: new Date().toISOString(),
        });
      }
      const material = choices.find((item) => item.id === values.materialId);
      if (!material) throw new Error('material missing');
      return createFilamentSpool({
        kind: values.kind,
        label: orNull(values.label),
        productId: values.manual ? null : values.productId || null,
        materialId: material.id,
        initialNetWeightG: toDecimal(parseDecimal(values.weight) ?? 0),
        stockMode: values.source,
        totalPrice: values.source === 'new_acquisition' ? toDecimal(parseDecimal(values.price) ?? 0) : null,
        supplier: values.source === 'new_acquisition' ? orNull(values.supplier) : null,
        manufacturer: orNull(values.manufacturer),
        productName: orNull(values.product),
        tareWeightG: tare == null ? null : toDecimal(tare),
        acquiredOn: values.acquiredOn || null,
        acquisitionReference: orNull(values.reference),
        storageLocation: orNull(values.location),
        notes: orNull(values.notes),
        occurredAt: new Date().toISOString(),
        expectedInventoryVersion: material.inventoryVersion,
      });
    },
  });
  const resetForm = useLatestCallback(() => {
    reset(defaults());
    mutation.reset();
  });
  useEffect(() => {
    if (open) resetForm();
  }, [open, spool?.id, initialMaterialId, resetForm]);
  const pending = mutation.isPending;
  const source = watch('source');
  const productId = watch('productId');
  const manual = watch('manual');
  const selectedProduct = products.find((item) => item.id === productId);
  const chooseProduct = (product: FilamentProduct | null) => {
    setValue('productId', product?.id ?? '', { shouldValidate: Boolean(product) });
    if (!product) return;
    setValue('materialId', product.materialId, { shouldValidate: true });
    setValue('weight', String(toNumber(product.netWeightG)));
    setValue('manufacturer', product.manufacturer);
    setValue('product', product.name);
    // The price is only used for a purchase; it stays editable.
    setValue('price', product.defaultPrice != null ? String(toNumber(product.defaultPrice)) : '');
    setValue('kind', product.packaging === 'spool' ? 'single_use' : 'reusable');
  };
  const setManual = (next: boolean) => {
    setValue('manual', next);
    if (next) {
      setValue('productId', '');
      clearErrors('productId');
    }
  };
  const selectedMaterial = choices.find((material) => material.id === watch('materialId'));
  const available = selectedMaterial ? toNumber(selectedMaterial.unassignedQuantity) : 0;
  const typedWeight = parseDecimal(watch('weight')) ?? 0;
  const effect = !selectedMaterial
    ? undefined
    : source === 'existing_stock'
      ? `Moves ${formatGrams(typedWeight)} from loose stock to this spool. The material total stays ${formatGrams(toNumber(selectedMaterial.quantity))}.`
      : `Adds ${formatGrams(typedWeight)} to ${selectedMaterial.name} stock (new total ${formatGrams(toNumber(selectedMaterial.quantity) + typedWeight)}) and records the purchase.`;

  const submit = handleSubmit(async (values) => {
    let saved: FilamentSpool;
    try {
      saved = await mutation.mutateAsync(values);
    } catch {
      await refresh();
      return;
    }
    await refresh();
    notify({
      kind: 'success',
      title: spool ? 'Spool saved' : 'Spool registered',
      subtitle: `${saved.displayId}${saved.materialName ? ` · ${saved.materialName}` : ''}`,
    });
    onClose();
  });

  return (
    <Modal
      open={open}
      size="md"
      modalHeading={spool ? `Edit ${spool.displayId}` : 'Register spool'}
      primaryButtonText={pending ? 'Saving…' : spool ? 'Save spool' : 'Register spool'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || (!spool && !materials.isSuccess)}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        void submit();
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
          {mutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Not saved"
              subtitle={spoolErrorMessage(mutation.error)}
            />
          )}
          {(materials.isError || catalog.isError) && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Not loaded"
              subtitle="Materials and products could not be loaded. Close the dialog and try again."
            />
          )}
          {materials.isSuccess && choices.length === 0 && !spool && (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="No filament materials"
              subtitle="Add a material in the Filament category first."
            />
          )}
          <Controller
            control={control}
            name="kind"
            render={({ field }) => (
              <RadioButtonGroup
                legendText="Type"
                name="spool-kind"
                orientation="vertical"
                valueSelected={field.value}
                disabled={Boolean(spool)}
                helperText={
                  field.value === 'reusable'
                    ? 'Refilled many times, e.g. a Bambu spool whose NFC tag changes with every refill.'
                    : 'Archived when finished; old archived spools can be cleaned up.'
                }
                onChange={(value) => field.onChange(value)}
              >
                <RadioButton id="spool-kind-reusable" value="reusable" labelText="Reusable" />
                <RadioButton id="spool-kind-single" value="single_use" labelText="Single-use" />
              </RadioButtonGroup>
            )}
          />
          <TextInput
            id="spool-label"
            labelText="Label (optional)"
            helperText="For example Bambu spool 03."
            autoComplete="off"
            maxLength={120}
            {...register('label')}
          />
          {!spool && watch('kind') === 'reusable' && (
            <Controller
              control={control}
              name="firstFill"
              render={({ field }) => (
                <RadioButtonGroup
                  legendText="First fill"
                  name="spool-first-fill"
                  orientation="vertical"
                  valueSelected={field.value}
                  onChange={(value) => field.onChange(value)}
                >
                  <RadioButton id="spool-first-fill-yes" value="fill" labelText="With a first fill" />
                  <RadioButton
                    id="spool-first-fill-no"
                    value="empty"
                    labelText="Register empty and fill later (Change filament)"
                  />
                </RadioButtonGroup>
              )}
            />
          )}
          {showFill && !spool && (
            <Controller
              control={control}
              name="productId"
              rules={{
                validate: (value, form) =>
                  form.manual || Boolean(value) || 'Choose a product, or select Not in catalog.',
              }}
              render={({ fieldState }) => (
                <ProductPicker
                  id="spool-product-picker"
                  products={products}
                  productId={productId}
                  manual={manual}
                  onProduct={chooseProduct}
                  onManual={setManual}
                  invalid={fieldState.invalid}
                  invalidText={fieldState.error?.message}
                />
              )}
            />
          )}
          {showFill && selectedProduct && (
            <TextInput
              id="spool-material-product"
              labelText="Material"
              readOnly
              value={selectedMaterial?.name ?? selectedProduct.materialName}
              helperText="Set by the product."
            />
          )}
          {showFill && !selectedProduct && (
            <Select
              id="spool-material"
              labelText="Material"
              disabled={Boolean(spool)}
              helperText={spool ? 'The material of a registered spool cannot change.' : undefined}
              invalid={Boolean(errors.materialId)}
              invalidText={errors.materialId?.message}
              {...register('materialId', { validate: (value) => !showFill || Boolean(value) || 'Choose a material.' })}
            >
              <SelectItem value="" text="Choose a material" />
              {choices.map((material) => (
                <SelectItem
                  key={material.id}
                  value={material.id}
                  text={material.active ? material.name : `${material.name} (inactive)`}
                />
              ))}
            </Select>
          )}
          {showFill && (
            <TextInput
              id="spool-weight"
              labelText="Initial net weight (g)"
              inputMode="decimal"
              autoComplete="off"
              disabled={Boolean(spool)}
              helperText={
                spool
                  ? 'Corrections change the remaining weight; the initial weight stays.'
                  : 'Filament weight without the spool.'
              }
              invalid={Boolean(errors.weight)}
              invalidText={errors.weight?.message}
              {...register('weight', {
                validate: (value) => {
                  if (!showFill) return true;
                  const weight = parseDecimal(value);
                  if (weight == null || weight <= 0) return 'Enter a weight above zero.';
                  return !spool && source === 'existing_stock' && weight > available
                    ? `Only ${formatGrams(available)} of loose stock is available.`
                    : true;
                },
              })}
            />
          )}
          <TextInput
            id="spool-tare"
            labelText="Tare weight in g (optional)"
            helperText="Empty spool, for weighing."
            inputMode="decimal"
            autoComplete="off"
            invalid={Boolean(errors.tare)}
            invalidText={errors.tare?.message}
            {...register('tare', { validate: nonNegative })}
          />
          {showFill && manual && (
            <TextInput
              id="spool-manufacturer"
              labelText="Manufacturer (optional)"
              autoComplete="off"
              maxLength={150}
              {...register('manufacturer')}
            />
          )}
          {showFill && manual && (
            <TextInput
              id="spool-product"
              labelText="Product (optional)"
              autoComplete="off"
              maxLength={200}
              {...register('product')}
            />
          )}
          <TextInput
            id="spool-location"
            labelText="Storage location (optional)"
            autoComplete="off"
            maxLength={200}
            {...register('location')}
          />
          {!spool && showFill && (
            <>
              <Controller
                control={control}
                name="source"
                render={({ field }) => (
                  <RadioButtonGroup
                    legendText="Stock source"
                    name="spool-source"
                    orientation="vertical"
                    valueSelected={field.value}
                    helperText={effect}
                    onChange={(value) => field.onChange(value)}
                  >
                    <RadioButton
                      id="spool-source-stock"
                      value="existing_stock"
                      labelText={`Taken from loose stock${selectedMaterial ? ` (${formatGrams(available)} available)` : ''}`}
                    />
                    <RadioButton id="spool-source-purchase" value="new_acquisition" labelText="Bought as a spool" />
                  </RadioButtonGroup>
                )}
              />
              {source === 'new_acquisition' && (
                <>
                  <TextInput
                    id="spool-price"
                    labelText="Total purchase price in EUR"
                    inputMode="decimal"
                    autoComplete="off"
                    invalid={Boolean(errors.price)}
                    invalidText={errors.price?.message}
                    {...register('price', {
                      validate: (value) =>
                        parseDecimal(value) == null ? 'Enter the total price, zero or more.' : nonNegative(value),
                    })}
                  />
                  <TextInput
                    id="spool-supplier"
                    labelText="Supplier (optional)"
                    autoComplete="off"
                    maxLength={200}
                    {...register('supplier')}
                  />
                </>
              )}
            </>
          )}
          <Controller
            control={control}
            name="acquiredOn"
            rules={{ required: 'Enter the acquisition date.' }}
            render={({ field, fieldState }) => (
              <DateInput
                id="spool-acquired"
                labelText="Acquired on"
                value={field.value}
                onChange={field.onChange}
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message}
                required
              />
            )}
          />
          <TextInput
            id="spool-reference"
            labelText="Acquisition reference (optional)"
            helperText="Invoice or order number."
            autoComplete="off"
            maxLength={200}
            {...register('reference')}
          />
          <TextArea id="spool-notes" labelText="Notes (optional)" rows={3} maxLength={2000} {...register('notes')} />
        </Stack>
      </form>
    </Modal>
  );
}
