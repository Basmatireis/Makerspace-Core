import { useState } from 'react';
import { Button, Modal, Stack, TextInput, Toggle } from '@carbon/react';
import { Add, Save } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MachineType } from '../../../api/generated/models';
import { createMachineType, updateMachineType } from '../../../api/generated/machines/machines';
import { machineLogbookKeys, machineTypesQuery } from '../queries';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useNotify } from '../shared/toasts';

type Taken = (name: string, id?: string) => boolean;

function TypeRow({ type, taken }: { type: MachineType; taken: Taken }) {
  const client = useQueryClient();
  const notify = useNotify();
  const [name, setName] = useState(type.name);
  const trimmed = name.trim();
  const dirty = trimmed !== type.name;
  const error = dirty && (!trimmed ? 'Enter a name.' : taken(trimmed, type.id) ? 'This name is already used.' : undefined);
  const save = useMutation({
    mutationFn: (patch: { name?: string; active?: boolean }) => updateMachineType(type.id, { ...patch, expectedVersion: type.version }),
    onSuccess: async (saved, patch) => {
      notify({
        kind: 'success', subtitle: saved.name,
        title: patch.name !== undefined ? 'Machine type renamed' : saved.active ? 'Machine type activated' : 'Machine type deactivated',
      });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
    onError: () => notify({ kind: 'error', title: 'Machine type not saved', subtitle: `${type.name} may have changed. Reload the list and try again.` }),
  });
  return (
    <div className="mj-type-row">
      <TextInput id={`type-name-${type.id}`} labelText="Type name" size="sm" value={name} invalid={Boolean(error)} invalidText={error || undefined} onChange={(event) => setName(event.target.value)} />
      <Button
        kind="ghost" size="sm" renderIcon={Save} disabled={!dirty || Boolean(error) || save.isPending}
        onClick={() => save.mutate({ name: trimmed })}
      >
        Save name
      </Button>
      <Toggle
        id={`type-active-${type.id}`} className="mj-type-row__toggle" size="sm" labelText={`${type.name} active`} hideLabel
        labelA="Inactive" labelB="Active" toggled={type.active} disabled={save.isPending}
        onToggle={(checked) => save.mutate({ active: checked })}
      />
    </div>
  );
}

export function MachineTypesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const client = useQueryClient();
  const notify = useNotify();
  const query = useQuery({ ...machineTypesQuery(), enabled: open });
  const [newName, setNewName] = useState('');
  const types = query.data?.items ?? [];
  const taken: Taken = (name, id) => types.some((type) => type.id !== id && type.name.toLowerCase() === name.toLowerCase());
  const trimmed = newName.trim();
  const addError = trimmed && taken(trimmed) ? 'This name is already used.' : undefined;
  const create = useMutation({
    mutationFn: (name: string) => createMachineType({ name }),
    onSuccess: async (saved) => {
      notify({ kind: 'success', title: 'Machine type added', subtitle: saved.name });
      setNewName('');
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
    onError: () => notify({ kind: 'error', title: 'Machine type not added', subtitle: 'Check that the name is unique and try again.' }),
  });

  const add = () => {
    if (!trimmed || addError || create.isPending) return;
    create.mutate(trimmed);
  };

  return (
    <Modal open={open} passiveModal size="md" modalHeading="Manage machine types" onRequestClose={onClose}>
      <QueryBoundary query={query} errorMessage="The machine types could not be loaded.">
        <Stack gap={5}>
          <p className="mj-secondary">Inactive types stay on existing machines but can't be chosen for new ones.</p>
          <div role="group" aria-label="Machine types">
            {types.length === 0 && <p>No machine types yet.</p>}
            {types.map((type) => <TypeRow key={`${type.id}:${type.version}`} type={type} taken={taken} />)}
          </div>
          <form className="mj-type-row" onSubmit={(event) => { event.preventDefault(); add(); }}>
            <TextInput id="type-new" labelText="New type name" size="sm" value={newName} invalid={Boolean(addError)} invalidText={addError} onChange={(event) => setNewName(event.target.value)} />
            <Button type="submit" kind="tertiary" size="sm" renderIcon={Add} disabled={!trimmed || Boolean(addError) || create.isPending}>Add type</Button>
          </form>
        </Stack>
      </QueryBoundary>
    </Modal>
  );
}
