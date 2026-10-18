import { useState } from 'react';
import { InlineNotification, Modal, Select, SelectItem, Stack, TextInput, Toggle } from '@carbon/react';
import { useStore } from '../../store';
import { organizationKinds } from '../labels';
import { defaultGroupOf } from '../pricing';
import { useSalesMutation } from '../useSalesMutation';
import type { BillingContact, OrganizationKind, OrganizationRecord } from '../types';

const BLANK: BillingContact = { addressLine1: '', postalCode: '', locality: '', countryCode: 'AT', contactName: '' };

/** Creates or edits an organization: an institute, company or association. Everybody else is an account that is priced by account role. */
export function OrganizationModal({ organization, onClose }: { organization: OrganizationRecord | null; onClose: () => void }) {
  const store = useStore();
  const [name, setName] = useState(organization?.name ?? '');
  const [kind, setKind] = useState<OrganizationKind>(organization?.kind ?? 'company');
  const [group, setGroup] = useState(organization?.pricingGroup ?? '');
  const [requiresPo, setRequiresPo] = useState(organization?.requiresPurchaseOrder ?? false);
  const [active, setActive] = useState(organization?.active ?? true);
  const [billing, setBilling] = useState<BillingContact>(organization?.billing ?? BLANK);
  const defaultName = defaultGroupOf(store.pricing).name;
  const set = (patch: Partial<BillingContact>) => setBilling((current) => ({ ...current, ...patch }));
  const { mutate, pending, error } = useSalesMutation(() => store.saveOrganization({ id: organization?.id, name, kind, pricingGroup: group || null, requiresPurchaseOrder: requiresPo, active, billing }));
  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: organization ? 'Organization saved' : 'Organization added', subtitle: organization ? undefined : `${name.trim()} can now be chosen as a customer.` });
    onClose();
  };
  return (
    <Modal open size="md" modalHeading={organization ? 'Edit organization' : 'New organization'} modalLabel="Pricing" primaryButtonText={pending ? 'Saving…' : 'Save'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || name.trim() === ''} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}>
      <Stack gap={5}>
        <p className="mj-secondary">Organizations are the only customers that are not accounts. Their group and invoice requirements apply to every job and invoice request from now on.</p>
        <TextInput id="organization-name" labelText="Name" value={name} maxLength={120} disabled={pending} onChange={(event) => setName(event.target.value)} />
        <Select id="organization-kind" labelText="Kind" value={kind} disabled={pending} onChange={(event) => setKind(event.target.value as OrganizationKind)}>
          {organizationKinds.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
        </Select>
        <Select id="organization-group" labelText="Pricing group" value={group} disabled={pending} helperText="Wins over the account roles of its members." onChange={(event) => setGroup(event.target.value)}>
          <SelectItem value="" text={`Default group (${defaultName})`} />
          {store.pricing.groups.filter((item) => item.active || item.name === organization?.pricingGroup).map((item) => <SelectItem key={item.id} value={item.name} text={`${item.name}${item.active ? '' : ' (inactive)'}`} />)}
        </Select>
        <Toggle id="organization-po" labelText="Purchase order reference" labelA="Not required" labelB="Required on every invoice request" toggled={requiresPo} disabled={pending} onToggle={setRequiresPo} />
        <Toggle id="organization-active" labelText="Status" labelA="Inactive" labelB="Active" toggled={active} disabled={pending} onToggle={setActive} />
        <fieldset className="sales-fieldset">
          <legend className="cds--label">Invoice address (prefilled in invoice requests)</legend>
          <Stack gap={5}>
            <TextInput id="organization-address" labelText="Street and number" value={billing.addressLine1} disabled={pending} onChange={(event) => set({ addressLine1: event.target.value })} />
            <div className="sales-form-grid">
              <TextInput id="organization-postal" labelText="Postal code" value={billing.postalCode} disabled={pending} onChange={(event) => set({ postalCode: event.target.value })} />
              <TextInput id="organization-locality" labelText="Town" value={billing.locality} disabled={pending} onChange={(event) => set({ locality: event.target.value })} />
              <TextInput id="organization-country" labelText="Country code" value={billing.countryCode} maxLength={2} disabled={pending} onChange={(event) => set({ countryCode: event.target.value })} />
            </div>
            <TextInput id="organization-contact" labelText="Contact person" value={billing.contactName} disabled={pending} onChange={(event) => set({ contactName: event.target.value })} />
          </Stack>
        </fieldset>
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
