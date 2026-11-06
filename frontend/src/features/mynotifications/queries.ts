import { queryOptions } from '@tanstack/react-query';
import {
  getOwnNotificationSettings,
  getOwnNotificationSubscription,
  listOwnNotificationSubscriptions,
} from '../../api/generated/notification-rules/notification-rules';

// Under the notification center's key root so one invalidation there refreshes everything about notifications, but
// spelled out here so the consent gate does not load the rule editor's modules just for a key.
export const myNotificationKeys = {
  all: ['notification-center', 'mine'] as const,
  settings: () => [...myNotificationKeys.all, 'settings'] as const,
  subscriptions: () => [...myNotificationKeys.all, 'subscriptions'] as const,
  subscription: (id: string) => [...myNotificationKeys.all, 'subscription', id] as const,
};

export const ownSettingsQuery = () =>
  queryOptions({
    queryKey: myNotificationKeys.settings(),
    queryFn: ({ signal }) => getOwnNotificationSettings({ signal }),
  });

export const ownSubscriptionsQuery = () =>
  queryOptions({
    queryKey: myNotificationKeys.subscriptions(),
    queryFn: ({ signal }) => listOwnNotificationSubscriptions({ signal }),
  });

export const ownSubscriptionQuery = (id: string) =>
  queryOptions({
    queryKey: myNotificationKeys.subscription(id),
    queryFn: ({ signal }) => getOwnNotificationSubscription(id, { signal }),
  });
