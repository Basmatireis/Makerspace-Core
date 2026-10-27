import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PermissionId } from '../../api/generated/models';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SettingsPageLayout } from './SettingsPageLayout';
import { SettingsTabs, type SettingsTab } from './SettingsTabs';

const SessionPoliciesPanel = lazy(() =>
  import('../devices/SessionPoliciesPage').then(({ SessionPoliciesPanel }) => ({ default: SessionPoliciesPanel })),
);
const ManagedDevicesPanel = lazy(() =>
  import('../devices/ManagedDevicesPage').then(({ ManagedDevicesPanel }) => ({ default: ManagedDevicesPanel })),
);
const DeviceTypesTab = lazy(() =>
  import('../devices/DeviceTypesPage').then(({ DeviceTypesTab }) => ({ default: DeviceTypesTab })),
);
const DeviceDetailPage = lazy(() =>
  import('../devices/DeviceDetailPage').then(({ DeviceDetailPage }) => ({ default: DeviceDetailPage })),
);

/**
 * Session limits, trusted devices and their types. The device detail page is routed here, below the settings path,
 * so that the application's entry route table does not grow.
 */
export function DevicesSessionsPage() {
  const currentUser = useCurrentUser();
  const canReadDevices = hasPermission(currentUser, PermissionId.managed_devicesread);
  return (
    <Routes>
      <Route index element={<DevicesSessionsTabs />} />
      {canReadDevices && <Route path="devices/:deviceId" element={<DeviceDetailPage />} />}
      <Route path="*" element={<Navigate to="/settings/devices-sessions" replace />} />
    </Routes>
  );
}

/** Shows only the tabs the person may use. */
function DevicesSessionsTabs() {
  const currentUser = useCurrentUser();
  const canReadDevices = hasPermission(currentUser, PermissionId.managed_devicesread);
  const tabs: SettingsTab[] = [
    ...(canReadDevices ? [{ key: 'managed-devices', label: 'Managed devices', panel: <ManagedDevicesPanel /> }] : []),
    ...(hasPermission(currentUser, PermissionId.session_policiesmanage)
      ? [{ key: 'session-policies', label: 'Session policies', panel: <SessionPoliciesPanel /> }]
      : []),
    ...(canReadDevices ? [{ key: 'device-types', label: 'Device types', panel: <DeviceTypesTab /> }] : []),
  ];
  return (
    <SettingsPageLayout page="devices-sessions" width="wide">
      <SettingsTabs label="Devices and sessions sections" tabs={tabs} />
    </SettingsPageLayout>
  );
}
