import { useState } from 'react';
import { Button, InlineNotification, Stack, TextArea, TextInput } from '@carbon/react';
import { DateInput } from '../../../../app/DateInput';
import { useStore } from '../../store';
import { useSalesMutation } from '../useSalesMutation';
import type { InvoiceRequest, InvoiceRequestDetails } from '../types';

/** The recipient and service fields of an invoice request. Everything the readiness checklist asks for is edited here. */
export function RecipientFields({ idPrefix, details, onChange, organization, requiresPurchaseOrder, disabled = false }: {
  idPrefix: string; details: InvoiceRequestDetails; onChange: (patch: Partial<InvoiceRequestDetails>) => void; organization: boolean; requiresPurchaseOrder: boolean; disabled?: boolean;
}) {
  const field = (id: string, label: string, key: keyof InvoiceRequestDetails, extra: { helperText?: string; maxLength?: number } = {}) => (
    <TextInput id={`${idPrefix}-${id}`} labelText={label} value={details[key]} maxLength={extra.maxLength ?? 200} helperText={extra.helperText} disabled={disabled} onChange={(event) => onChange({ [key]: event.target.value })} />
  );
  const periodInvalid = !!details.serviceStartsOn && !!details.serviceEndsOn && details.serviceStartsOn > details.serviceEndsOn;
  return (
    <Stack gap={5}>
      {field('name', 'Recipient name', 'recipientName', { helperText: 'Exactly as it should appear on the invoice.' })}
      {field('address', 'Street and number', 'addressLine1')}
      <div className="sales-form-grid">
        {field('postal', 'Postal code', 'postalCode')}
        {field('locality', 'Town', 'locality')}
        {field('country', 'Country code', 'countryCode', { helperText: 'Two letters, e.g. AT', maxLength: 2 })}
      </div>
      {organization && field('contact', 'Contact person', 'contactName', { helperText: 'Organizations need someone to address the invoice to.' })}
      {organization && field('po', requiresPurchaseOrder ? 'Purchase order reference (required)' : 'Purchase order reference', 'purchaseOrderReference', { helperText: requiresPurchaseOrder ? 'This organization requires one on every invoice.' : 'Optional for this organization.' })}
      <div className="sales-form-grid">
        <DateInput id={`${idPrefix}-period-start`} labelText="Service period from" value={details.serviceStartsOn} onChange={(value) => onChange({ serviceStartsOn: value })} invalid={periodInvalid} invalidText="The period must end on or after its start" />
        <DateInput id={`${idPrefix}-period-end`} labelText="Service period through" value={details.serviceEndsOn} onChange={(value) => onChange({ serviceEndsOn: value })} />
      </div>
      <TextArea id={`${idPrefix}-description`} labelText="Service description" rows={2} maxCount={500} enableCounter value={details.serviceDescription} disabled={disabled} onChange={(event) => onChange({ serviceDescription: event.target.value })} />
    </Stack>
  );
}

/** The recipient details of a draft request, saved on their own. The details freeze when the request is marked ready. */
export function RecipientDetailsForm({ request, organization, requiresPurchaseOrder, onChange }: {
  request: InvoiceRequest; organization: boolean; requiresPurchaseOrder: boolean; onChange: (details: InvoiceRequestDetails, dirty: boolean) => void;
}) {
  const store = useStore();
  const [details, setDetails] = useState<InvoiceRequestDetails>(request.details);
  const dirty = JSON.stringify(details) !== JSON.stringify(request.details);
  const { mutate, pending, error } = useSalesMutation(() => store.updateRequestDetails(request.id, details));
  const set = (patch: Partial<InvoiceRequestDetails>) => { const next = { ...details, ...patch }; setDetails(next); onChange(next, JSON.stringify(next) !== JSON.stringify(request.details)); };
  const save = async () => {
    const result = await mutate();
    if (result.ok) { store.notify({ kind: 'success', title: 'Recipient details saved' }); onChange(details, false); }
  };
  return (
    <Stack gap={5}>
      <RecipientFields idPrefix={`recipient-${request.id}`} details={details} onChange={set} organization={organization} requiresPurchaseOrder={requiresPurchaseOrder} disabled={pending} />
      {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Details not saved" subtitle={error} />}
      <div className="mj-inline">
        <Button kind="primary" size="md" disabled={!dirty || pending} onClick={() => { void save(); }}>{pending ? 'Saving…' : 'Save details'}</Button>
        <Button kind="ghost" size="md" disabled={!dirty || pending} onClick={() => { setDetails(request.details); onChange(request.details, false); }}>Discard changes</Button>
        {dirty && <span className="mj-secondary">Unsaved changes</span>}
      </div>
    </Stack>
  );
}
