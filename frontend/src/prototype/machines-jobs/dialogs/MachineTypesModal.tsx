import { useState } from 'react';
import { Button, Modal, Stack, TextInput, Toggle } from '@carbon/react';
import { Add, Save } from '@carbon/icons-react';
import { useStore } from '../store';
import type { MachineType } from '../types';

function TypeRow({ type, taken }: { type: MachineType; taken: (name: string, id?: string) => boolean }) {
  const store = useStore();
  const [name, setName] = useState(type.name);
  const trimmed = name.trim();
  const dirty = trimmed !== type.name;
  const error = dirty && (!trimmed ? 'Enter a name.' : taken(trimmed, type.id) ? 'This name is already used.' : undefined);
  return (
    <div className="mj-type-row">
      <TextInput id={`type-name-${type.id}`} labelText="Type name" size="sm" value={name} invalid={Boolean(error)} invalidText={error} onChange={(event) => setName(event.target.value)} />
      <Button
        kind="ghost" size="sm" renderIcon={Save} disabled={!dirty || Boolean(error)}
        onClick={() => { store.saveMachineType({ id: type.id, name: trimmed, active: type.active }); store.notify({ kind: 'success', title: 'Machine type renamed', subtitle: trimmed }); }}
      >
        Save name
      </Button>
      <Toggle
        id={`type-active-${type.id}`} className="mj-type-row__toggle" size="sm" labelText="Active" hideLabel aria-label={`${type.name} active`}
        labelA="Inactive" labelB="Active" toggled={type.active}
        onToggle={(checked) => { store.saveMachineType({ id: type.id, name: type.name, active: checked }); store.notify({ kind: 'success', title: checked ? 'Machine type activated' : 'Machine type deactivated', subtitle: type.name }); }}
      />
    </div>
  );
}

export function MachineTypesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useStore();
  const [newName, setNewName] = useState('');
  const taken = (name: string, id?: string) => store.machineTypes.some((type) => type.id !== id && type.name.toLowerCase() === name.toLowerCase());
  const trimmed = newName.trim();
  const addError = trimmed && taken(trimmed) ? 'This name is already used.' : undefined;

  const add = () => {
    if (!trimmed || addError) return;
    store.saveMachineType({ name: trimmed, active: true });
    store.notify({ kind: 'success', title: 'Machine type added', subtitle: trimmed });
    setNewName('');
  };

  return (
    <Modal open={open} passiveModal size="md" modalHeading="Manage machine types" onRequestClose={onClose}>
      <Stack gap={5}>
        <p className="mj-secondary">Inactive types stay on existing machines but can't be chosen for new ones.</p>
        <div role="group" aria-label="Machine types">
          {store.machineTypes.length === 0 && <p>No machine types yet.</p>}
          {store.machineTypes.map((type) => <TypeRow key={`${type.id}:${type.name}`} type={type} taken={taken} />)}
        </div>
        <form className="mj-type-row" onSubmit={(event) => { event.preventDefault(); add(); }}>
          <TextInput id="type-new" labelText="New type name" size="sm" value={newName} invalid={Boolean(addError)} invalidText={addError} onChange={(event) => setNewName(event.target.value)} />
          <Button type="submit" kind="tertiary" size="sm" renderIcon={Add} disabled={!trimmed || Boolean(addError)}>Add type</Button>
        </form>
      </Stack>
    </Modal>
  );
}
