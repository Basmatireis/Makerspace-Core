import { Column, Grid, Stack, ClickableTile } from '@carbon/react';
import { DataBase, Devices, Document, Group, UserMultiple, IbmCloudKeyProtect, Email } from '@carbon/icons-react';
import { PageHeader } from '../../app/PageHeader';
import { useCurrentUser } from '../auth/auth';
import { hasAnyPermission, PermissionId } from '../auth/permissions';

export function SettingsPage() {
  const currentUser = useCurrentUser();
  const canUseUsers = hasAnyPermission(currentUser, [
    PermissionId.peoplereadall,
  ]);
  const canUseRoles = hasAnyPermission(currentUser, [PermissionId.rolesread]);
  const canUseDevices = hasAnyPermission(currentUser, [PermissionId.managed_devicesread]);
	const canUseLaborordnung = hasAnyPermission(currentUser, [PermissionId.laborordnungread, PermissionId.laborordnungmanage, PermissionId.laborordnungrequestsread]);
  const canManageOIDC = hasAnyPermission(currentUser, [PermissionId.oidcmanage]);
  const canManageSCIM = hasAnyPermission(currentUser, [PermissionId.scimmanage]);
  const canManageVisitorEnrollment = hasAnyPermission(currentUser, [PermissionId.visitor_enrollmentmanage]);
  const canManageMail = hasAnyPermission(currentUser, [PermissionId.mailmanage]);

  return (
    <Stack gap={8}>
      <PageHeader
        title="Settings"
        description="Administration tools available to your account."
      />
      <Grid condensed className="settings-grid">
        {canUseUsers && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile href="/settings/users" className="settings-tile">
              <Stack gap={5}>
                <UserMultiple size={32} />
                <div>
                  <h2>Members</h2>
                  <p>Manage member records, login accounts, roles, and security.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canUseRoles && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile href="/settings/roles" className="settings-tile">
              <Stack gap={5}>
                <Group size={32} />
                <div>
                  <h2>Roles</h2>
                  <p>Configure reusable permission sets for accounts.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
        {canUseDevices && (
          <Column sm={4} md={4} lg={5}>
            <ClickableTile href="/settings/managed-devices" className="settings-tile">
              <Stack gap={5}>
                <Devices size={32} />
                <div>
                  <h2>Managed devices</h2>
                  <p>Register trusted terminals and device types.</p>
                </div>
              </Stack>
            </ClickableTile>
          </Column>
        )}
		{canUseLaborordnung && <Column sm={4} md={4} lg={5}><ClickableTile href="/settings/laborordnung" className="settings-tile"><Stack gap={5}><Document size={32} /><div><h2>Lab Rules</h2><p>Publish PDFs and verify physical evidence.</p></div></Stack></ClickableTile></Column>}
        {canManageOIDC && <Column sm={4} md={4} lg={5}><ClickableTile href="/settings/oidc" className="settings-tile"><Stack gap={5}><IbmCloudKeyProtect size={32} /><div><h2>OpenID Connect</h2><p>Configure external identity providers and trusted assurance.</p></div></Stack></ClickableTile></Column>}
        {canManageSCIM && <Column sm={4} md={4} lg={5}><ClickableTile href="/settings/scim" className="settings-tile"><Stack gap={5}><DataBase size={32} /><div><h2>SCIM provisioning</h2><p>Manage connectors, bearer tokens, and Account reconciliation.</p></div></Stack></ClickableTile></Column>}
        {canManageVisitorEnrollment && <Column sm={4} md={4} lg={5}><ClickableTile href="/settings/visitor-enrollment" className="settings-tile"><Stack gap={5}><UserMultiple size={32} /><div><h2>Visitor enrollment</h2><p>Configure approved terminals, the initial Role, and authentication methods.</p></div></Stack></ClickableTile></Column>}
        {canManageMail && <Column sm={4} md={4} lg={5}><ClickableTile href="/settings/mail" className="settings-tile"><Stack gap={5}><Email size={32} /><div><h2>Email delivery</h2><p>Configure SMTP, sender identity, and recovery-link delivery.</p></div></Stack></ClickableTile></Column>}
      </Grid>
    </Stack>
  );
}
