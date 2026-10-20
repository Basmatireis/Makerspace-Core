import {
  Button,
  ComposedModal,
  Form,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { createManagedDeviceType } from '../../../api/generated/managed-devices/managed-devices';
import type { ManagedDeviceType } from '../../../api/generated/models';
import { InlineLoadingState } from '../../../app/PageState';
import { MutationError } from './ConfirmationModal';

export function DeviceTypesPanel({
  types,
  loading,
  canManage,
  onEdit,
  onDelete,
  onCreated,
}: {
  types: ManagedDeviceType[];
  loading: boolean;
  canManage: boolean;
  onEdit: (type: ManagedDeviceType) => void;
  onDelete: (type: ManagedDeviceType) => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const createMutation = useMutation({
    mutationFn: () => createManagedDeviceType({ name: name.trim(), description: description.trim() || null }),
    onSuccess: async () => {
      setName('');
      setDescription('');
      await onCreated();
    },
  });
  return (
    <Tile>
      <Stack gap={5}>
        <h2>Device types</h2>
        {loading && <InlineLoadingState label="Loading device types" />}
        {types.map((type) => (
          <div className="section-heading" key={type.id}>
            <div>
              <strong>{type.name}</strong>
              <p className="section-description">{type.description || 'No description'}</p>
            </div>
            {canManage && (
              <div className="button-cluster">
                <Button kind="ghost" size="sm" onClick={() => onEdit(type)}>
                  Edit
                </Button>
                <Button kind="danger--ghost" size="sm" onClick={() => onDelete(type)}>
                  Delete
                </Button>
              </div>
            )}
          </div>
        ))}
        {canManage && (
          <Form
            onSubmit={(event) => {
              event.preventDefault();
              createMutation.mutate();
            }}
          >
            <Stack gap={4}>
              {createMutation.isError && <MutationError title="Device type not created" error={createMutation.error} />}
              <TextInput
                id="new-type-name"
                labelText="Type name"
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
              <TextArea
                id="new-type-description"
                labelText="Description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
              <Button type="submit" disabled={!name.trim() || createMutation.isPending}>
                Create device type
              </Button>
            </Stack>
          </Form>
        )}
      </Stack>
    </Tile>
  );
}

export function DeviceTypeModal({
  type,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  type: ManagedDeviceType;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (value: { name: string; description: string | null }) => void;
}) {
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description ?? '');
  return (
    <ComposedModal open onClose={onClose}>
      <ModalHeader title="Edit device type" />
      <ModalBody>
        <Stack gap={5}>
          {error && <MutationError title="Device type not updated" error={error} />}
          <TextInput
            id="edit-type-name"
            labelText="Type name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <TextArea
            id="edit-type-description"
            labelText="Description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={pending || !name.trim()}
          onClick={() => onSubmit({ name: name.trim(), description: description.trim() || null })}
        >
          Save
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}
