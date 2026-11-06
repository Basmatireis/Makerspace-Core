import { useQuery } from '@tanstack/react-query';
import { useLocation, useParams } from 'react-router-dom';
import type { NotificationRule } from '../../api/generated/models';
import { ErrorState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import { catalogQuery } from '../notificationcenter/queries';
import { RuleEditor } from '../notificationcenter/RuleEditorPage';
import { blankDefinition, draftFromRule, newAction, type RuleDraft } from '../notificationcenter/ruleModel';
import { ownSubscriptionQuery } from './queries';

type NavigationState = { template?: NotificationRule; starter?: RuleDraft } | null;

/** The rule editor in personal mode: create a subscription, start from a ready-made one, or edit an existing one. */
export function SubscriptionPage() {
  const { subscriptionId } = useParams();
  const location = useLocation();
  const catalog = useQuery(catalogQuery());
  const subscription = useQuery({ ...ownSubscriptionQuery(subscriptionId ?? ''), enabled: Boolean(subscriptionId) });

  const queries = [catalog, ...(subscriptionId ? [subscription] : [])];
  if (queries.some((query) => query.status === 'error')) {
    return (
      <PageShell title="Subscription" width="wide">
        <ErrorState
          message="The subscription could not be loaded."
          onRetry={() => queries.forEach((query) => void query.refetch())}
        />
      </PageShell>
    );
  }
  if (!catalog.data || (subscriptionId && !subscription.data)) {
    return (
      <PageShell title="Subscription" width="wide">
        <SettingsLoading label="Loading subscription" />
      </PageShell>
    );
  }

  const state = location.state as NavigationState;
  let initial: RuleDraft;
  if (subscription.data) {
    initial = draftFromRule(subscription.data);
  } else if (state?.starter) {
    initial = state.starter;
  } else if (state?.template) {
    // A copy starts switched off so it cannot double-send until it has been looked at.
    initial = { ...draftFromRule(state.template), name: `Copy of ${state.template.name}`, enabled: false };
  } else {
    initial = {
      name: '',
      description: '',
      categoryId: '',
      enabled: true,
      mandatory: false,
      definition: {
        ...blankDefinition(catalog.data, catalog.data.triggers.length ? 'event' : 'schedule'),
        actions: [newAction('in_app', true)],
      },
    };
  }
  return (
    <RuleEditor
      key={`${subscription.data?.id ?? 'new'}-${subscription.data?.version ?? 0}`}
      catalog={catalog.data}
      categories={[]}
      rule={subscription.data}
      initial={initial}
      canManage
      personal
    />
  );
}
