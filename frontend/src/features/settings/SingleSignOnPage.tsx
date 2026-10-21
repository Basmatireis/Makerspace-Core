import { lazy } from 'react';
import { PermissionId } from '../../api/generated/models';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SettingsPageLayout } from './SettingsPageLayout';
import { SettingsTabs, type SettingsTab } from './SettingsTabs';

const OIDCProvidersPanel = lazy(() =>
  import('../oidc/OIDCProvidersPage').then(({ OIDCProvidersPanel }) => ({ default: OIDCProvidersPanel })),
);
const SCIMConnectorsPanel = lazy(() =>
  import('../scim/SCIMConnectorsPage').then(({ SCIMConnectorsPanel }) => ({ default: SCIMConnectorsPanel })),
);

/** External sign-in and account provisioning; shows only the tabs the person may manage. */
export function SingleSignOnPage() {
  const currentUser = useCurrentUser();
  const tabs: SettingsTab[] = [
    ...(hasPermission(currentUser, PermissionId.oidcmanage)
      ? [{ key: 'oidc', label: 'OpenID Connect', panel: <OIDCProvidersPanel /> }]
      : []),
    ...(hasPermission(currentUser, PermissionId.scimmanage)
      ? [{ key: 'scim', label: 'SCIM provisioning', panel: <SCIMConnectorsPanel /> }]
      : []),
  ];
  return (
    <SettingsPageLayout page="single-sign-on">
      <SettingsTabs label="Single sign-on sections" tabs={tabs} />
    </SettingsPageLayout>
  );
}
