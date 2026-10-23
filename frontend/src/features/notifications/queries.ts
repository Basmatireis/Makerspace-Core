import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import {
  getNotificationUnreadCount,
  listNotifications,
  listSentNotificationMessages,
} from '../../api/generated/notifications/notifications';

/** The header polls the unread count this often; TanStack pauses it while the tab is hidden. */
export const UNREAD_POLL_INTERVAL_MS = 60_000;
/** Notifications shown in the header panel; older ones expire after 90 days anyway. */
export const PANEL_PAGE_SIZE = 20;

export const notificationKeys = {
  all: ['notifications'] as const,
  unread: () => [...notificationKeys.all, 'unread'] as const,
  list: () => [...notificationKeys.all, 'list'] as const,
  sent: (page: number, pageSize: number) => [...notificationKeys.all, 'sent', page, pageSize] as const,
};

export const unreadCountQuery = () =>
  queryOptions({
    queryKey: notificationKeys.unread(),
    queryFn: ({ signal }) => getNotificationUnreadCount({ signal }),
    refetchInterval: UNREAD_POLL_INTERVAL_MS,
  });

export const notificationListQuery = () =>
  queryOptions({
    queryKey: notificationKeys.list(),
    queryFn: ({ signal }) => listNotifications({ page: 1, pageSize: PANEL_PAGE_SIZE }, { signal }),
  });

export const sentMessagesQuery = (page: number, pageSize: number) =>
  queryOptions({
    queryKey: notificationKeys.sent(page, pageSize),
    queryFn: ({ signal }) => listSentNotificationMessages({ page, pageSize }, { signal }),
    placeholderData: keepPreviousData,
  });
