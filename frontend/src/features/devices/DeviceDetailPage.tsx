import { useState } from 'react';
import { Button, StructuredListBody, StructuredListWrapper, Tag } from '@carbon/react';
import { Renew, TrashCan, Edit, Locked } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  deleteManagedDevice,
  getManagedDevice,
  getManagedDeviceHardware,
  listManagedDeviceTypes,
  listSessionPolicies,
  revokeManagedDevice,
  rotateManagedDeviceToken,
  updateManagedDevice,
} from '../../api/generated/managed-devices/managed-devices';
import type {
  DeviceCapability,
  ManagedDevice,
  ManagedDeviceCredentialDelivery,
  ManagedDeviceProvisioning,
} from '../../api/generated/models';
import { DetailRow, DetailSection } from '../../app/DetailSection';
import { formatDateTime } from '../../app/dateTime';
import { ErrorState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import { ConfirmationModal } from './components/ConfirmationModal';
import { DeviceFormModal, OneTimeToken } from './components/DeviceFormModal';
import { DeviceStatusTag } from './components/DeviceStatusTag';
import {
  assuranceLabels,
  capabilityLabels,
  checkoutModeLabels,
  keys,
  modeLabels,
  type Confirmation,
  type DeviceConfiguration,
} from './components/deviceShared';
import { ExpirationModal } from './components/ExpirationModal';
import './devices.scss';

const devicesPath = '/settings/devices-sessions?tab=managed-devices';

/** One managed device: its settings, what it can do, and the actions on its credential. */
export function DeviceDetailPage() {
  const { deviceId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, PermissionId.managed_devicesmanage);
  const deviceKey = [...keys.devices, deviceId] as const;
  const deviceQuery = useQuery({
    queryKey: deviceKey,
    queryFn: ({ signal }) => getManagedDevice(deviceId, { signal }),
  });
  const hardwareQuery = useQuery({
    queryKey: [...deviceKey, 'hardware'],
    queryFn: ({ signal }) => getManagedDeviceHardware(deviceId, { signal }),
  });
  const typesQuery = useQuery({
    queryKey: keys.types,
    queryFn: ({ signal }) => listManagedDeviceTypes({ signal }),
    enabled: canManage,
  });
  const policiesQuery = useQuery({ queryKey: keys.policies, queryFn: ({ signal }) => listSessionPolicies({ signal }) });
  const [secret, setSecret] = useState<ManagedDeviceProvisioning | null>(null);
  const [editing, setEditing] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [rotatePending, setRotatePending] = useState(false);
  const [rotateError, setRotateError] = useState<Error | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: keys.devices });
  };

  const editMutation = useMutation({
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
      setEditing(false);
      await refresh();
    },
  });
  const lifecycleMutation = useMutation({
    mutationFn: async (value: NonNullable<Confirmation>) => {
      if (value.kind === 'revoke') {
        await revokeManagedDevice(value.device.id, { expectedVersion: value.device.version });
      } else if (value.kind === 'delete') {
        await deleteManagedDevice(value.device.id, { expectedVersion: value.device.version });
      }
      return value.kind;
    },
    onSuccess: async (kind) => {
      setConfirmation(null);
      await refresh();
      if (kind === 'delete') navigate(devicesPath, { replace: true });
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
      setRotating(false);
      setSecret(provisioning);
      await refresh();
    } catch (error) {
      setRotateError(error instanceof Error ? error : new Error('Token rotation failed'));
    } finally {
      setRotatePending(false);
    }
  };

  const device = deviceQuery.data;
  const policy = policiesQuery.data?.items.find((item) => item.id === device?.sessionPolicyId);
  const revoked = device?.status === 'revoked';

  return (
    <PageShell
      title={device?.name ?? 'Managed device'}
      description={device ? `${device.deviceTypeName} device` : undefined}
      width="wide"
      breadcrumbs={[
        { label: 'Settings', to: '/settings' },
        { label: 'Access & identity', to: '/settings#access' },
        { label: 'Devices & sessions', to: devicesPath },
        { label: device?.name ?? 'Device' },
      ]}
      actions={
        device && canManage ? (
          <Button kind="tertiary" renderIcon={Edit} onClick={() => setEditing(true)}>
            Edit device
          </Button>
        ) : undefined
      }
    >
      {deviceQuery.isPending && <SettingsLoading label="Loading managed device" />}
      {deviceQuery.isError && (
        <ErrorState
          title="Device not found"
          message="The device may have been deleted, or you may not be allowed to see it."
          onRetry={() => void deviceQuery.refetch()}
        />
      )}
      {secret && <OneTimeToken provisioning={secret} onDismiss={() => setSecret(null)} />}
      {device && (
        <div className="device-detail">
          <DetailSection title="General">
            <StructuredListWrapper isCondensed>
              <StructuredListBody>
                <DetailRow label="Name" value={device.name} />
                <DetailRow label="Type" value={device.deviceTypeName} />
                <DetailRow label="Status" value={<DeviceStatusTag status={device.status} />} />
                <DetailRow
                  label="Token expiration"
                  value={device.expiresAt ? formatDateTime(device.expiresAt) : 'No expiration'}
                />
                {device.revokedAt && <DetailRow label="Revoked" value={formatDateTime(device.revokedAt)} />}
                <DetailRow label="Last seen" value={device.lastSeenAt ? formatDateTime(device.lastSeenAt) : 'Never'} />
                <DetailRow label="Registered" value={formatDateTime(device.createdAt)} />
              </StructuredListBody>
            </StructuredListWrapper>
          </DetailSection>

          <DetailSection
            title="Application modes and kiosk"
            description="What the device may run and how a public kiosk handles check-in and check-out."
          >
            <StructuredListWrapper isCondensed>
              <StructuredListBody>
                <DetailRow
                  label="Allowed application modes"
                  value={device.allowedApplicationModes.map((mode) => modeLabels[mode]).join(', ')}
                />
                <DetailRow
                  label="Session policy"
                  value={
                    policy ? policy.name : device.sessionPolicyId ? 'Unknown policy' : 'Default private-device policy'
                  }
                />
                <DetailRow
                  label="Public visitor kiosk"
                  value={
                    device.terminalEnabled ? (
                      <Tag size="sm" type="blue">
                        Enabled
                      </Tag>
                    ) : (
                      'Off'
                    )
                  }
                />
                {device.terminalEnabled && (
                  <>
                    <DetailRow label="Check-in assurance" value={assuranceLabels[device.checkInAssurance]} />
                    <DetailRow label="Check-out assurance" value={assuranceLabels[device.checkOutAssurance]} />
                    <DetailRow label="Checkout mode" value={checkoutModeLabels[device.checkoutMode]} />
                  </>
                )}
              </StructuredListBody>
            </StructuredListWrapper>
          </DetailSection>

          <DetailSection
            title="Capabilities"
            description="Configured is what administrators permit; reported is what the device's app currently has; effective is what the device may use."
          >
            {hardwareQuery.isPending && <SettingsLoading label="Loading capabilities" />}
            {hardwareQuery.isError && (
              <ErrorState
                title="Capabilities unavailable"
                message="The capability report could not be loaded."
                onRetry={() => void hardwareQuery.refetch()}
              />
            )}
            {hardwareQuery.data && (
              <StructuredListWrapper isCondensed>
                <StructuredListBody>
                  <DetailRow
                    label="Configured"
                    value={<CapabilityTags values={hardwareQuery.data.configuredCapabilities} />}
                  />
                  <DetailRow
                    label="Reported"
                    value={
                      hardwareQuery.data.reportedAt ? (
                        <CapabilityTags values={hardwareQuery.data.reportedCapabilities} />
                      ) : (
                        <span className="settings-section__description">
                          Never reported. A browser kiosk is trusted to match its configuration.
                        </span>
                      )
                    }
                  />
                  <DetailRow
                    label="Effective"
                    value={<CapabilityTags values={hardwareQuery.data.effectiveCapabilities} />}
                  />
                  {hardwareQuery.data.reportedAt && (
                    <DetailRow
                      label="Last report"
                      value={`${hardwareQuery.data.platform ?? 'unknown'} app ${hardwareQuery.data.bridgeVersion ?? ''} · ${formatDateTime(hardwareQuery.data.reportedAt)}`}
                    />
                  )}
                </StructuredListBody>
              </StructuredListWrapper>
            )}
          </DetailSection>

          {canManage && (
            <DetailSection
              title="Credential"
              description="The device token is shown once. Rotating replaces it; revoking ends all access for good."
            >
              <div className="button-cluster">
                {!revoked && (
                  <Button kind="tertiary" renderIcon={Renew} onClick={() => setRotating(true)}>
                    Rotate token
                  </Button>
                )}
                {!revoked && (
                  <Button
                    kind="danger--tertiary"
                    renderIcon={Locked}
                    onClick={() => setConfirmation({ kind: 'revoke', device })}
                  >
                    Revoke
                  </Button>
                )}
                {revoked && (
                  <Button
                    kind="danger--tertiary"
                    renderIcon={TrashCan}
                    onClick={() => setConfirmation({ kind: 'delete', device })}
                  >
                    Delete device
                  </Button>
                )}
              </div>
              {revoked && (
                <p className="settings-section__description">
                  A revoked device cannot be used again. Delete the record once it is no longer needed.
                </p>
              )}
            </DetailSection>
          )}
        </div>
      )}
      {editing && device && typesQuery.data && (
        <DeviceFormModal
          device={device}
          types={typesQuery.data.items}
          policies={policiesQuery.data?.items ?? []}
          pending={editMutation.isPending}
          error={editMutation.error}
          onClose={() => setEditing(false)}
          onSubmit={(values) => editMutation.mutate({ device, ...values })}
        />
      )}
      {rotating && device && (
        <ExpirationModal
          device={device}
          pending={rotatePending}
          error={rotateError}
          onClose={() => {
            setRotating(false);
            setRotateError(null);
          }}
          onSubmit={(expiresAt, credentialDelivery) => void rotate(device, expiresAt, credentialDelivery)}
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
    </PageShell>
  );
}

function CapabilityTags({ values }: { values: DeviceCapability[] }) {
  if (values.length === 0) return <span className="settings-section__description">None</span>;
  return (
    <span className="device-capabilities">
      {values.map((value) => (
        <Tag key={value} size="sm" type="gray">
          {capabilityLabels[value]}
        </Tag>
      ))}
    </span>
  );
}
