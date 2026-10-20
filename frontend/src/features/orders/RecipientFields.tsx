import { Controller, type UseFormReturn } from 'react-hook-form';
import { Stack, TextArea, TextInput } from '@carbon/react';
import { DateInput } from '../../app/DateInput';
import type { RecipientValues } from './recipientValues';

/** The recipient and service fields of an invoice request. Everything the readiness checklist asks for is edited here. */
export function RecipientFields({
  form,
  idPrefix,
  organization,
  requiresPurchaseOrder,
  disabled = false,
}: {
  form: UseFormReturn<RecipientValues>;
  idPrefix: string;
  organization: boolean;
  requiresPurchaseOrder: boolean;
  disabled?: boolean;
}) {
  const field = (
    id: string,
    label: string,
    name: keyof RecipientValues,
    extra: { helperText?: string; maxLength?: number } = {},
  ) => (
    <TextInput
      id={`${idPrefix}-${id}`}
      labelText={label}
      maxLength={extra.maxLength ?? 200}
      helperText={extra.helperText}
      disabled={disabled}
      {...form.register(name)}
    />
  );
  const start = form.watch('serviceStartsOn');
  const end = form.watch('serviceEndsOn');
  const periodInvalid = !!start && !!end && start > end;
  return (
    <Stack gap={5}>
      {field('name', 'Recipient name', 'recipientName', { helperText: 'Exactly as it should appear on the invoice.' })}
      {field('address', 'Street and number', 'addressLine1')}
      <div className="sales-form-grid">
        {field('postal', 'Postal code', 'postalCode')}
        {field('locality', 'Town', 'locality')}
        {field('country', 'Country code', 'countryCode', { helperText: 'Two letters, e.g. AT', maxLength: 2 })}
      </div>
      {organization &&
        field('contact', 'Contact person', 'contactName', {
          helperText: 'Organizations need someone to address the invoice to.',
        })}
      {organization &&
        field(
          'po',
          requiresPurchaseOrder ? 'Purchase order reference (required)' : 'Purchase order reference',
          'purchaseOrderReference',
          {
            helperText: requiresPurchaseOrder
              ? 'This organization requires one on every invoice.'
              : 'Optional for this organization.',
          },
        )}
      <div className="sales-form-grid">
        <Controller
          control={form.control}
          name="serviceStartsOn"
          render={({ field: control }) => (
            <DateInput
              id={`${idPrefix}-period-start`}
              labelText="Service period from"
              value={control.value}
              onChange={control.onChange}
              invalid={periodInvalid}
              invalidText="The period must end on or after its start"
            />
          )}
        />
        <Controller
          control={form.control}
          name="serviceEndsOn"
          render={({ field: control }) => (
            <DateInput
              id={`${idPrefix}-period-end`}
              labelText="Service period through"
              value={control.value}
              onChange={control.onChange}
            />
          )}
        />
      </div>
      <TextArea
        id={`${idPrefix}-description`}
        labelText="Service description"
        rows={2}
        maxCount={500}
        enableCounter
        disabled={disabled}
        {...form.register('serviceDescription')}
      />
    </Stack>
  );
}
