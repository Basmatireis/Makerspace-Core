import { Stack, Tile } from '@carbon/react';
import { PageHeader } from '../../app/PageHeader';
import { useCurrentUser } from '../auth/auth';

export function DashboardPage() {
  const currentUser = useCurrentUser();

  return (
    <Stack gap={8}>
      <PageHeader
        title="Dashboard"
        description={`Welcome, ${currentUser.person.firstName}.`}
      />
      <Tile className="dashboard-intro">
        <Stack gap={4}>
          <h2>Welcome to Makerspace</h2>
          <p>
            Use the navigation to manage your profile and, when authorized,
            makerspace administration settings.
          </p>
        </Stack>
      </Tile>
    </Stack>
  );
}
