import { useState } from 'react';
import { InlineNotification, Modal, Select, SelectItem, Stack, TextArea, TextInput, Toggle } from '@carbon/react';
import { useStore } from '../../store';
import type { PricingGroup } from '../pricing';
import { useSalesMutation } from '../useSalesMutation';

/** Creates or edits a pricing group. A new group can start from the rates of an existing one, so it is not born with every rate missing. */
export function PricingGroupModal({ group, onClose }: { group: PricingGroup | null; onClose: () => void }) {
  const store = useStore();
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [active, setActive] = useState(group?.active ?? true);
  const [isDefault, setIsDefault] = useState(group?.isDefault ?? false);
  const [copyFrom, setCopyFrom] = useState('');
  const { mutate, pending, error } = useSalesMutation(() => {
    const { groupId } = store.savePricingGroup({ id: group?.id, name, description, active, isDefault });
    if (!group && copyFrom) for (const rule of store.pricing.rules.filter((item) => item.groupId === copyFrom)) store.setRate({ groupId, kind: rule.kind, machineTypeId: rule.machineTypeId, category: rule.category, unit: rule.unit, rate: rule.rate });
    return groupId;
  });
  const submit = async () => {
    const result = await mutate();
    if (!result.ok) return;
    store.notify({ kind: 'success', title: group ? 'Pricing group saved' : 'Pricing group created', subtitle: group ? undefined : copyFrom ? 'Its rates start as a copy. Adjust them in the matrix.' : 'It has no rates yet. Set them in the matrix.' });
    onClose();
  };
  return (
    <Modal open size="sm" modalHeading={group ? 'Edit pricing group' : 'New pricing group'} modalLabel="Pricing" primaryButtonText={pending ? 'Saving…' : 'Save'} secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || name.trim() === ''} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}>
      <Stack gap={5}>
        <TextInput id="group-name" labelText="Name" value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
        <TextArea id="group-description" labelText="Description" rows={2} maxCount={300} enableCounter value={description} onChange={(event) => setDescription(event.target.value)} helperText="Who this group is for." />
        <Toggle id="group-active" labelText="Status" labelA="Inactive" labelB="Active" toggled={active} onToggle={(checked) => { setActive(checked); if (!checked) setIsDefault(false); }} disabled={group?.isDefault} />
        <Toggle id="group-default" labelText="Default group" labelA="No" labelB="Yes, price customers without a group with it" toggled={isDefault} disabled={!active || group?.isDefault}
          onToggle={setIsDefault} />
        {group?.isDefault && <p className="mj-secondary">This is the default group. To change that, make another group the default.</p>}
        {!group && (
          <Select id="group-copy" labelText="Start with the rates of" value={copyFrom} onChange={(event) => setCopyFrom(event.target.value)} helperText="Optional.">
            <SelectItem value="" text="No rates (set them afterwards)" />
            {store.pricing.groups.map((item) => <SelectItem key={item.id} value={item.id} text={item.name} />)}
          </Select>
        )}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
