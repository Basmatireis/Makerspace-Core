import { useEffect } from 'react';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator } from '../../../app/decimalInput';
import { Controller, useForm } from 'react-hook-form';
import {
  ComboBox,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
  Toggle,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createFilamentProduct,
  updateFilamentProduct,
} from '../../../api/generated/filament-products/filament-products';
import type { FilamentPackaging, FilamentProduct, FilamentProductInput } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { isFilament, toDecimal, toMoney } from '../components/inventoryShared';
import { allMaterialsQuery, allProductsQuery } from '../inventoryQueries';
import { machineLogbookKeys } from '../queries';
import { useCan } from '../shared/useCan';
import { useNotify } from '../shared/toasts';
import { useLatestCallback } from '../../../app/useLatestCallback';

type Values = {
  manufacturer: string;
  name: string;
  materialId: string;
  netWeight: string;
  price: string;
  packaging: FilamentPackaging;
  notes: string;
  active: boolean;
};

/** Adds or edits a catalog product (needs `inventory.manage`). */
export function ProductFormModal({
  open,
  onClose,
  product,
  materialId,
}: {
  open: boolean;
  onClose: () => void;
  product?: FilamentProduct;
  materialId?: string;
}) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const materials = useQuery({ ...allMaterialsQuery(), enabled: open });
  const products = useQuery({ ...allProductsQuery(), enabled: open });
  const choices = (materials.data ?? []).filter(
    (material) => isFilament(material) && (material.active || material.id === product?.materialId),
  );
  const manufacturers = [...new Set((products.data ?? []).map((item) => item.manufacturer))].sort((a, b) =>
    a.localeCompare(b),
  );
  const defaults = (): Values => ({
    manufacturer: product?.manufacturer ?? '',
    name: product?.name ?? '',
    materialId: product?.materialId ?? materialId ?? '',
    netWeight: product ? decimalText(product.netWeightG) : '1000',
    price: product?.defaultPrice != null ? decimalText(product.defaultPrice) : '',
    packaging: product?.packaging ?? 'spool',
    notes: product?.notes ?? '',
    active: product?.active ?? true,
  });
  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setError,
    formState: { errors },
  } = useForm<Values>({ defaultValues: defaults() });
  const packaging = watch('packaging');

  const save = useMutation({
    mutationFn: (values: Values) => {
      const input: FilamentProductInput = {
        manufacturer: values.manufacturer.trim(),
        name: values.name.trim(),
        materialId: values.materialId,
        netWeightG: toDecimal(decimalNumber(values.netWeight) ?? 0),
        defaultPrice: decimalNumber(values.price) === null ? null : toMoney(decimalNumber(values.price) ?? 0),
        packaging: values.packaging,
        notes: values.notes.trim() || null,
      };
      return product
        ? updateFilamentProduct(product.id, { ...input, active: values.active, expectedVersion: product.version })
        : createFilamentProduct(input);
    },
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: product ? 'Product saved' : 'Product added',
        subtitle: `${saved.manufacturer} · ${saved.name}`,
      });
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && error.data?.code === 'product_exists')
        setError('name', { message: 'This manufacturer already has a product with this name.' });
    },
  });
  const resetForm = useLatestCallback(() => {
    reset(defaults());
    save.reset();
  });
  useEffect(() => {
    if (open) resetForm();
  }, [open, product?.id, materialId, resetForm]);
  const pending = save.isPending;
  const failure = save.error instanceof ApiError && save.error.data?.code === 'product_exists' ? null : save.error;

  const submit = handleSubmit((values) => {
    save.mutate(values);
  });
  const canManage = can('inventory.manage');

  return (
    <Modal
      open={open}
      size="md"
      modalHeading={product ? 'Edit product' : 'Add product'}
      primaryButtonText={pending ? 'Saving…' : product ? 'Save product' : 'Add product'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || !canManage}
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
          {!canManage && (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="No permission"
              subtitle="Changing the product catalog needs the inventory.manage permission."
            />
          )}
          <Controller
            control={control}
            name="manufacturer"
            rules={{ validate: (value) => (value.trim() ? true : 'Enter a manufacturer.') }}
            render={({ field, fieldState }) => (
              <ComboBox<string>
                key={`${open}-${product?.id ?? 'new'}`}
                id="product-manufacturer"
                titleText="Manufacturer"
                placeholder="Choose or type a manufacturer"
                items={manufacturers}
                allowCustomValue
                helperText="Pick an existing manufacturer or type a new one."
                itemToString={(item) => item ?? ''}
                initialSelectedItem={defaults().manufacturer || undefined}
                onInputChange={(value) => field.onChange(value ?? '')}
                onChange={({ selectedItem }) => field.onChange(selectedItem ?? '')}
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message}
              />
            )}
          />
          <TextInput
            id="product-name"
            labelText="Product"
            helperText="For example PLA Basic Black."
            autoComplete="off"
            invalid={Boolean(errors.name)}
            invalidText={errors.name?.message}
            {...register('name', {
              validate: (value, form) => {
                if (!value.trim()) return 'Enter a product name.';
                const duplicate = (products.data ?? []).some(
                  (item) =>
                    item.id !== product?.id &&
                    item.manufacturer.trim().toLowerCase() === form.manufacturer.trim().toLowerCase() &&
                    item.name.trim().toLowerCase() === value.trim().toLowerCase(),
                );
                return duplicate ? 'This manufacturer already has a product with this name.' : true;
              },
            })}
          />
          {/* Controlled: the options arrive with the materials query, after the form's initial value is set. */}
          <Controller
            control={control}
            name="materialId"
            rules={{ required: 'Choose a material.' }}
            render={({ field, fieldState }) => (
              <Select
                id="product-material"
                labelText="Material"
                helperText="The stock that bought grams count towards. Its category drives job pricing."
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message}
                value={field.value}
                onChange={(event) => field.onChange(event.target.value)}
                onBlur={field.onBlur}
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
          />
          <Controller
            control={control}
            name="netWeight"
            rules={{ validate: decimalValidator({ positive: true, requiredMessage: 'Enter a weight above zero.' }) }}
            render={({ field, fieldState }) => (
              <DecimalField
                id="product-weight"
                labelText="Net weight (g)"
                helperText="Filament without the spool."
                value={field.value}
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={control}
            name="price"
            rules={{ validate: decimalValidator({ optional: true, places: 2 }) }}
            render={({ field, fieldState }) => (
              <DecimalField
                id="product-price"
                labelText="Default price (€, optional)"
                helperText={`Per ${packaging === 'refill' ? 'refill' : 'spool'} bought. Prefilled for a new purchase.`}
                value={field.value}
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={control}
            name="packaging"
            render={({ field }) => (
              <RadioButtonGroup
                legendText="Packaging"
                name="product-packaging"
                orientation="vertical"
                valueSelected={field.value}
                onChange={(value) => field.onChange(value)}
              >
                <RadioButton
                  id="product-packaging-refill"
                  value="refill"
                  labelText="Refill — filament only, for reusable spools"
                />
                <RadioButton
                  id="product-packaging-spool"
                  value="spool"
                  labelText="Spool — comes on its own single-use spool"
                />
              </RadioButtonGroup>
            )}
          />
          <TextArea id="product-notes" labelText="Notes (optional)" rows={3} {...register('notes')} />
          {product && (
            <Controller
              control={control}
              name="active"
              render={({ field }) => (
                <Toggle
                  id="product-active"
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
              title="The product was not saved"
              subtitle={failure instanceof ApiError ? failure.message : 'Try again.'}
            />
          )}
        </Stack>
      </form>
    </Modal>
  );
}
