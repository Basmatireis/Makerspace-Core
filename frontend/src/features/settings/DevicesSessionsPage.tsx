import { lazy } from 'react';
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

/** Session limits and trusted terminals; shows only the tabs the person may use. */
export function DevicesSessionsPage() {
  const currentUser = useCurrentUser();
  const tabs: SettingsTab[] = [
    ...(hasPermission(currentUser, PermissionId.session_policiesmanage)
      ? [{ key: 'session-policies', label: 'Session policies', panel: <SessionPoliciesPanel /> }]
      : []),
    ...(hasPermission(currentUser, PermissionId.managed_devicesread)
      ? [{ key: 'managed-devices', label: 'Managed devices', panel: <ManagedDevicesPanel /> }]
      : []),
  ];
  return (
    <SettingsPageLayout page="devices-sessions" width="wide">
      <SettingsTabs label="Devices and sessions sections" tabs={tabs} />
    </SettingsPageLayout>
  );
}
