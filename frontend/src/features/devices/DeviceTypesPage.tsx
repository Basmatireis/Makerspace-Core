import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  deleteManagedDeviceType,
  listManagedDeviceTypes,
  updateManagedDeviceType,
} from '../../api/generated/managed-devices/managed-devices';
import type { ManagedDeviceType } from '../../api/generated/models';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { SettingsSection } from '../settings/SettingsPageLayout';
import { ConfirmationModal } from './components/ConfirmationModal';
import { DeviceTypeModal, DeviceTypesPanel } from './components/DeviceTypesPanel';
import { keys, type Confirmation } from './components/deviceShared';

/** Device types: the categories a managed device is registered under. */
export function DeviceTypesTab() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const canManage = hasPermission(currentUser, PermissionId.managed_devicesmanage);
  const typesQuery = useQuery({ queryKey: keys.types, queryFn: ({ signal }) => listManagedDeviceTypes({ signal }) });
  const [editingType, setEditingType] = useState<ManagedDeviceType | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.types });

  const editTypeMutation = useMutation({
    mutationFn: ({ type, name, description }: { type: ManagedDeviceType; name: string; description: string | null }) =>
      updateManagedDeviceType(type.id, { name, description, expectedVersion: type.version }),
    onSuccess: async () => {
      setEditingType(null);
      await refresh();
    },
  });
  const deleteTypeMutation = useMutation({
    mutationFn: async (value: NonNullable<Confirmation>) => {
      if (value.kind === 'delete-type') {
        await deleteManagedDeviceType(value.type.id, { expectedVersion: value.type.version });
      }
    },
    onSuccess: async () => {
      setConfirmation(null);
      await refresh();
    },
  });

  return (
    <SettingsSection
      title="Device types"
      description="Categories such as reception kiosk or workshop PC. Every managed device belongs to one."
    >
      {typesQuery.isError && (
        <ErrorState
          title="Unable to load device types"
          message="Check the connection and try again."
          onRetry={() => void typesQuery.refetch()}
        />
      )}
      <DeviceTypesPanel
        types={typesQuery.data?.items ?? []}
        loading={typesQuery.isPending}
        canManage={canManage}
        onEdit={setEditingType}
        onDelete={(type) => setConfirmation({ kind: 'delete-type', type })}
        onCreated={refresh}
      />
      {editingType && (
        <DeviceTypeModal
          type={editingType}
          pending={editTypeMutation.isPending}
          error={editTypeMutation.error}
          onClose={() => setEditingType(null)}
          onSubmit={(values) => editTypeMutation.mutate({ type: editingType, ...values })}
        />
      )}
      <ConfirmationModal
        value={confirmation}
        pending={deleteTypeMutation.isPending}
        error={deleteTypeMutation.error}
        onClose={() => {
          setConfirmation(null);
          deleteTypeMutation.reset();
        }}
        onConfirm={() => confirmation && deleteTypeMutation.mutate(confirmation)}
      />
    </SettingsSection>
  );
}
