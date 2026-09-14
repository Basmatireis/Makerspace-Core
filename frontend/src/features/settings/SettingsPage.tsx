import { Column, Grid, Stack, ClickableTile } from '@carbon/react';
import { Group, UserMultiple } from '@carbon/icons-react';
import { PageHeader } from '../../app/PageHeader';
import { useCurrentUser } from '../auth/auth';
import { hasAnyPermission, PermissionId } from '../auth/permissions';

export function SettingsPage() {
  const currentUser = useCurrentUser();
  const canUseUsers = hasAnyPermission(currentUser, [
    PermissionId.peoplereadall,
  ]);
  const canUseRoles = hasAnyPermission(currentUser, [PermissionId.rolesread]);

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
      </Grid>
    </Stack>
  );
}
