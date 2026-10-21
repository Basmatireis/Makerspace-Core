import { Button, Stack } from '@carbon/react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  deleteManagedDevice,
  deleteManagedDeviceType,
  listManagedDevices,
  listManagedDeviceTypes,
  revokeManagedDevice,
  rotateManagedDeviceToken,
  updateManagedDevice,
  updateManagedDeviceType,
  listSessionPolicies,
} from '../../api/generated/managed-devices/managed-devices';
import type {
  ManagedDevice,
  ManagedDeviceCredentialDelivery,
  ManagedDeviceProvisioning,
  ManagedDeviceType,
} from '../../api/generated/models';
import { ErrorState } from '../../app/PageState';
import { SettingsLoading, SettingsSection } from '../settings/SettingsPageLayout';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { keys, DeviceConfiguration, Confirmation } from './components/deviceShared';
import { DeviceTable } from './components/DeviceTable';
import { CreateDeviceForm, DeviceFormModal, OneTimeToken } from './components/DeviceFormModal';
import { ExpirationModal } from './components/ExpirationModal';
import { DeviceTypesPanel, DeviceTypeModal } from './components/DeviceTypesPanel';
import { ConfirmationModal } from './components/ConfirmationModal';

export function ManagedDevicesPanel() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const canManage = hasPermission(currentUser, PermissionId.managed_devicesmanage);
  const devicesQuery = useInfiniteQuery({
    queryKey: keys.devices,
    queryFn: ({ signal, pageParam }) => listManagedDevices({ limit: 50, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const typesQuery = useQuery({
    queryKey: keys.types,
    queryFn: ({ signal }) => listManagedDeviceTypes({ signal }),
  });
  const policiesQuery = useQuery({ queryKey: keys.policies, queryFn: ({ signal }) => listSessionPolicies({ signal }) });
  const [secret, setSecret] = useState<ManagedDeviceProvisioning | null>(null);
  const [editingDevice, setEditingDevice] = useState<ManagedDevice | null>(null);
  const [rotatingDevice, setRotatingDevice] = useState<ManagedDevice | null>(null);
  const [editingType, setEditingType] = useState<ManagedDeviceType | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [rotatePending, setRotatePending] = useState(false);
  const [rotateError, setRotateError] = useState<Error | null>(null);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.devices }),
      queryClient.invalidateQueries({ queryKey: keys.types }),
    ]);
  };

  const editDeviceMutation = useMutation({
    mutationFn: ({
      device,
      name,
      deviceTypeId,
      expiresAt,
      ...configuration
    }: {
      device: ManagedDevice;
      name: string;
      deviceTypeId: string;
      expiresAt: string | null;
    } & DeviceConfiguration) =>
      updateManagedDevice(device.id, {
        name,
        deviceTypeId,
        expiresAt,
        expectedVersion: device.version,
        ...configuration,
      }),
    onSuccess: async () => {
      setEditingDevice(null);
      await refresh();
    },
  });
  const rotate = async (
    device: ManagedDevice,
    expiresAt: string | null,
    credentialDelivery: ManagedDeviceCredentialDelivery,
  ) => {
    setRotatePending(true);
    setRotateError(null);
    try {
      const provisioning = await rotateManagedDeviceToken(device.id, {
        expiresAt,
        expectedVersion: device.version,
        credentialDelivery,
      });
      setRotatingDevice(null);
      setSecret(provisioning);
      await refresh();
    } catch (error) {
      setRotateError(error instanceof Error ? error : new Error('Token rotation failed'));
    } finally {
      setRotatePending(false);
    }
  };
  const lifecycleMutation = useMutation({
    mutationFn: async (value: NonNullable<Confirmation>) => {
      if (value.kind === 'delete-type') {
        await deleteManagedDeviceType(value.type.id, { expectedVersion: value.type.version });
        return;
      }
      if (value.kind === 'revoke') {
        await revokeManagedDevice(value.device.id, { expectedVersion: value.device.version });
      } else {
        await deleteManagedDevice(value.device.id, { expectedVersion: value.device.version });
      }
    },
    onSuccess: async () => {
      setConfirmation(null);
      await refresh();
    },
  });
  const editTypeMutation = useMutation({
    mutationFn: ({ type, name, description }: { type: ManagedDeviceType; name: string; description: string | null }) =>
      updateManagedDeviceType(type.id, {
        name,
        description,
        expectedVersion: type.version,
      }),
    onSuccess: async () => {
      setEditingType(null);
      await refresh();
    },
  });
  return (
    <SettingsSection
      title="Managed devices"
      description="Register trusted local computers and control device-scoped access."
    >
      {secret && <OneTimeToken provisioning={secret} onDismiss={() => setSecret(null)} />}
      {devicesQuery.isPending && <SettingsLoading label="Loading managed devices" />}
      {devicesQuery.isError && (
        <ErrorState
          title="Unable to load managed devices"
          message="Check the connection and try again."
          onRetry={() => void devicesQuery.refetch()}
        />
      )}
      {devicesQuery.data && (
        <Stack gap={4}>
          <DeviceTable
            devices={devicesQuery.data.pages.flatMap((page) => page.items)}
            canManage={canManage}
            onEdit={setEditingDevice}
            onRotate={setRotatingDevice}
            onConfirm={(kind, device) => setConfirmation({ kind, device })}
          />
          {devicesQuery.hasNextPage && (
            <Button
              kind="tertiary"
              disabled={devicesQuery.isFetchingNextPage}
              onClick={() => void devicesQuery.fetchNextPage()}
            >
              Load more devices
            </Button>
          )}
        </Stack>
      )}
      {canManage && typesQuery.data && (
        <CreateDeviceForm
          types={typesQuery.data.items}
          policies={policiesQuery.data?.items ?? []}
          onCreated={async (value) => {
            setSecret(value);
            await refresh();
          }}
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
      {editingDevice && typesQuery.data && (
        <DeviceFormModal
          device={editingDevice}
          types={typesQuery.data.items}
          policies={policiesQuery.data?.items ?? []}
          pending={editDeviceMutation.isPending}
          error={editDeviceMutation.error}
          onClose={() => setEditingDevice(null)}
          onSubmit={(values) => editDeviceMutation.mutate({ device: editingDevice, ...values })}
        />
      )}
      {rotatingDevice && (
        <ExpirationModal
          device={rotatingDevice}
          pending={rotatePending}
          error={rotateError}
          onClose={() => {
            setRotatingDevice(null);
            setRotateError(null);
          }}
          onSubmit={(expiresAt, credentialDelivery) => void rotate(rotatingDevice, expiresAt, credentialDelivery)}
        />
      )}
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
        pending={lifecycleMutation.isPending}
        error={lifecycleMutation.error}
        onClose={() => {
          setConfirmation(null);
          lifecycleMutation.reset();
        }}
        onConfirm={() => confirmation && lifecycleMutation.mutate(confirmation)}
      />
    </SettingsSection>
  );
}
