import { useQuery } from '@tanstack/react-query';
import { ErrorState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import { catalogQuery } from '../notificationcenter/queries';
import { ConsentCards } from './ConsentCards';
import { ownSettingsQuery, ownSubscriptionsQuery } from './queries';
import { ReachingRulesTable } from './ReachingRulesTable';
import { SubscriptionsSection } from './SubscriptionsSection';
import './mynotifications.scss';

const breadcrumbs = [{ label: 'Your account', to: '/profile' }];

/** What the signed-in person allows, which central rules reach them and how, and their own subscriptions. */
export function MyNotificationsPage() {
  const settings = useQuery(ownSettingsQuery());
  const subscriptions = useQuery(ownSubscriptionsQuery());
  const catalog = useQuery(catalogQuery());
  const queries = [settings, subscriptions, catalog];

  let body;
  if (queries.some((query) => query.status === 'error')) {
    body = (
      <ErrorState
        message="Your notification settings could not be loaded."
        onRetry={() => queries.forEach((query) => void query.refetch())}
      />
    );
  } else if (!settings.data || !subscriptions.data || !catalog.data) {
    body = <SettingsLoading label="Loading your notification settings" />;
  } else {
    body = (
      <div className="mn-page">
        <ConsentCards settings={settings.data} />
        <ReachingRulesTable settings={settings.data} />
        <SubscriptionsSection catalog={catalog.data} subscriptions={subscriptions.data.items} />
      </div>
    );
  }
  return (
    <PageShell title="My notifications" width="wide" breadcrumbs={breadcrumbs}>
      <p className="mn-intro">
        What we may send you, which rules reach you and how. Mute what you don&apos;t need and add your own
        subscriptions.
      </p>
      {body}
    </PageShell>
  );
}
