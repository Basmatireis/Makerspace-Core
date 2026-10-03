import { Stack, Tile } from '@carbon/react';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { useBranding } from '../branding/branding';

export function DashboardPage() {
  const currentUser = useCurrentUser();
  const branding = useBranding();

  return (
    <PageShell
      title="Dashboard"
      description={`Welcome, ${currentUser.person.firstName}.`}
    >
      <Tile className="dashboard-intro">
        <Stack gap={4}>
          <h2>Welcome to {branding.identity.displayName}</h2>
          <p>
            Use the navigation to manage your profile and, when authorized,
            {branding.identity.displayName} administration settings.
          </p>
        </Stack>
      </Tile>
    </PageShell>
  );
}
