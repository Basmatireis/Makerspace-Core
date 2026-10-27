import { useState } from 'react';
import { Button, Link as CarbonLink, Tag } from '@carbon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { listManagedDeviceTypes, listSessionPolicies } from '../../api/generated/managed-devices/managed-devices';
import type { ManagedDevice, ManagedDeviceProvisioning, ManagedDeviceStatus } from '../../api/generated/models';
import { ErrorState } from '../../app/PageState';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DirectoryTable, useUrlState, type Column } from '../machinelogbook/shared/DirectoryTable';
import { SettingsLoading, SettingsSection } from '../settings/SettingsPageLayout';
import { CreateDeviceModal, OneTimeToken } from './components/DeviceFormModal';
import { DeviceStatusTag } from './components/DeviceStatusTag';
import { devicePaths, keys, modeLabels } from './components/deviceShared';
import { useAllManagedDevices } from './queries';

const statuses: ManagedDeviceStatus[] = ['active', 'expired', 'revoked'];
const statusOptions = statuses.map((status) => ({ id: status, label: status[0].toUpperCase() + status.slice(1) }));

const columns: Column<ManagedDevice>[] = [
  {
    key: 'name',
    header: 'Device',
    sortValue: (device) => device.name.toLowerCase(),
    render: (device) => (
      <div className="mj-cell-stack">
        <CarbonLink as={Link} to={devicePaths.detail(device.id)}>
          {device.name}
        </CarbonLink>
        <span className="mj-secondary mj-show-narrow">{device.deviceTypeName}</span>
      </div>
    ),
  },
  {
    key: 'type',
    header: 'Type',
    narrow: true,
    sortValue: (device) => device.deviceTypeName.toLowerCase(),
    render: (device) => device.deviceTypeName,
  },
  {
    key: 'modes',
    header: 'Application modes',
    narrow: true,
    render: (device) => device.allowedApplicationModes.map((mode) => modeLabels[mode]).join(', '),
  },
  {
    key: 'kiosk',
    header: 'Kiosk',
    narrow: true,
    sortValue: (device) => Number(device.terminalEnabled),
    render: (device) =>
      device.terminalEnabled ? (
        <Tag size="sm" type="blue">
          Enabled
        </Tag>
      ) : (
        <span className="mj-secondary">Off</span>
      ),
  },
  {
    key: 'lastSeen',
    header: 'Last seen',
    narrow: true,
    firstDirection: 'DESC',
    sortValue: (device) => device.lastSeenAt ?? '',
    render: (device) => (device.lastSeenAt ? formatDateTime(device.lastSeenAt) : 'Never'),
  },
  {
    key: 'status',
    header: 'Status',
    sortValue: (device) => device.status,
    render: (device) => <DeviceStatusTag status={device.status} />,
  },
];

export function ManagedDevicesPanel() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canManage = hasPermission(currentUser, PermissionId.managed_devicesmanage);
  const url = useUrlState('dev-');
  const [createOpen, setCreateOpen] = useState(false);
  const [secret, setSecret] = useState<ManagedDeviceProvisioning | null>(null);
  const { query: devicesQuery, devices } = useAllManagedDevices();
  const typesQuery = useQuery({
    queryKey: keys.types,
    queryFn: ({ signal }) => listManagedDeviceTypes({ signal }),
    enabled: canManage,
  });
  const policiesQuery = useQuery({
    queryKey: keys.policies,
    queryFn: ({ signal }) => listSessionPolicies({ signal }),
    enabled: canManage,
  });
  const all = devices ?? [];
  const selectedStatuses = url.list('status');
  const rows = selectedStatuses.length ? all.filter((device) => selectedStatuses.includes(device.status)) : all;

  return (
    <SettingsSection
      title="Managed devices"
      description="Trusted computers and tablets, the application modes they may run and their kiosk settings."
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
        <DirectoryTable<ManagedDevice>
          id="devices"
          urlPrefix="dev-"
          label="Managed devices"
          columns={columns}
          rows={rows}
          totalCount={all.length}
          searchText={(device) => `${device.name} ${device.deviceTypeName}`}
          defaultSort={{ key: 'name', direction: 'ASC' }}
          filterCategories={[{ key: 'status', label: 'Status', options: statusOptions }]}
          onRowClick={(device) => navigate(devicePaths.detail(device.id))}
          toolbarAction={
            canManage ? (
              <Button kind="primary" size="lg" disabled={!typesQuery.data} onClick={() => setCreateOpen(true)}>
                New device
              </Button>
            ) : undefined
          }
          empty={{
            title: 'No managed devices yet',
            description: 'Register a device to give a kiosk or workstation its own credential.',
          }}
        />
      )}
      {createOpen && typesQuery.data && (
        <CreateDeviceModal
          types={typesQuery.data.items}
          policies={policiesQuery.data?.items ?? []}
          onClose={() => setCreateOpen(false)}
          onCreated={async (value) => {
            setCreateOpen(false);
            setSecret(value);
            await queryClient.invalidateQueries({ queryKey: keys.devices });
          }}
        />
      )}
    </SettingsSection>
  );
}
