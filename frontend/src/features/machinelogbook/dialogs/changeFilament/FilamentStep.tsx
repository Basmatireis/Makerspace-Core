import { Controller } from 'react-hook-form';
import { InlineNotification, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, TextInput } from '@carbon/react';
import { DecimalField } from '../../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator } from '../../../../app/decimalInput';
import { formatGrams } from '../../components/inventoryShared';
import { type ChangeFilamentWizard } from './useChangeFilamentWizard';

export function FilamentStep({ wizard }: { wizard: ChangeFilamentWizard }) {
  const {
    canPurchase,
    filaments,
    values,
    refillOnly,
    material,
    stockAfterClose,
    stock,
    sourceHelper,
    nextFill,
    name,
    errors,
    control,
    register,
    setValue,
  } = wizard;

  return (
    <Stack gap={6}>
      {refillOnly && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Needs refill"
          subtitle={`${name} has no filament. The new fill is fill ${nextFill}.`}
        />
      )}
      <Select
        id="refill-material"
        labelText="Filament"
        invalid={Boolean(errors.materialId)}
        invalidText={errors.materialId?.message}
        {...register('materialId', {
          required: 'Choose a filament.',
          onChange: (event) => {
            const next = filaments.find((item) => item.id === event.target.value);
            if (next?.packageSize != null) setValue('netWeight', decimalText(next.packageSize));
          },
        })}
      >
        <SelectItem value="" text="Choose a filament" />
        {filaments.map((item) => (
          <SelectItem key={item.id} value={item.id} text={item.name} />
        ))}
      </Select>
      <Controller
        control={control}
        name="netWeight"
        rules={{
          validate: (value, form) => {
            const valid = decimalValidator({
              positive: true,
              requiredMessage: 'Enter a weight above zero.',
            })(value);
            if (valid !== true) return valid;
            const target = filaments.find((item) => item.id === form.materialId);
            return form.source === 'loose_stock' &&
              target &&
              (decimalNumber(value) ?? 0) > stockAfterClose(target.id).loose
              ? `Only ${formatGrams(stockAfterClose(target.id).loose)} of loose stock is available.`
              : true;
          },
        }}
        render={({ field, fieldState }) => (
          <DecimalField
            id="refill-weight"
            labelText="Net weight of the new filament (g)"
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
        name="source"
        render={({ field }) => (
          <RadioButtonGroup
            legendText="Where does the filament come from?"
            name="refill-source"
            orientation="vertical"
            valueSelected={field.value}
            helperText={sourceHelper}
            onChange={(value) => field.onChange(value)}
          >
            <RadioButton
              id="refill-source-stock"
              value="loose_stock"
              labelText={`From loose stock${material ? ` (${formatGrams(stock.loose)} available)` : ''}`}
            />
            <RadioButton
              id="refill-source-purchase"
              value="purchase"
              disabled={!canPurchase}
              labelText={canPurchase ? 'New purchase' : 'New purchase (needs the inventory.manage permission)'}
            />
          </RadioButtonGroup>
        )}
      />
      {values.source === 'purchase' && (
        <>
          <Controller
            control={control}
            name="price"
            rules={{
              validate: (value, form) =>
                form.source !== 'purchase' ||
                decimalValidator({ places: 2, requiredMessage: 'Enter the total price, zero or more.' })(value),
            }}
            render={({ field, fieldState }) => (
              <DecimalField
                id="refill-price"
                labelText="Total price (€)"
                helperText="Updates the average acquisition cost."
                value={field.value}
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message}
                onChange={field.onChange}
              />
            )}
          />
          <TextInput
            id="refill-supplier"
            labelText="Supplier (optional)"
            autoComplete="off"
            {...register('supplier')}
          />
        </>
      )}
      <TextInput
        id="refill-manufacturer"
        labelText="Manufacturer (optional)"
        helperText="Defaults to the manufacturer of the article."
        autoComplete="off"
        {...register('manufacturer')}
      />
      <TextInput id="refill-product" labelText="Product name (optional)" autoComplete="off" {...register('product')} />
    </Stack>
  );
}
