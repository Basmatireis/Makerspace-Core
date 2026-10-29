import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/toasts';
import { useOpenNotification } from './openNotification';
import { notificationListQuery, unreadCountQuery } from './queries';

const MAX_TOASTS = 3;
const MAX_BODY_LENGTH = 140;

function shorten(text: string): string {
  return text.length <= MAX_BODY_LENGTH ? text : `${text.slice(0, MAX_BODY_LENGTH - 1).trimEnd()}…`;
}

/**
 * Shows a toast for each notification that arrives while the tab is open. It watches the header's polled unread
 * count (no second poller): when the count rises above the previous value, the latest notifications are fetched and
 * the newest unread ones are shown. The first value only sets the baseline.
 */
export function useNewNotificationToasts(): void {
  const queryClient = useQueryClient();
  const notify = useNotify();
  const open = useOpenNotification();
  const unread = useQuery(unreadCountQuery()).data?.unreadCount;
  const previous = useRef<number | undefined>(undefined);
  const shown = useRef(new Set<string>());
  // The effect must not restart when these change identity; it reads the latest ones through a ref.
  const latest = useRef({ notify, open });
  useEffect(() => {
    latest.current = { notify, open };
  });

  useEffect(() => {
    if (unread === undefined) return;
    const before = previous.current;
    previous.current = unread;
    if (before === undefined || unread <= before) return;
    const rise = unread - before;
    void queryClient
      .fetchQuery({ ...notificationListQuery(), staleTime: 0 })
      .then((list) => {
        const fresh = list.items.filter((item) => !item.readAt && !shown.current.has(item.id)).slice(0, rise);
        for (const item of fresh.slice(0, MAX_TOASTS).reverse()) {
          shown.current.add(item.id);
          latest.current.notify({
            kind: 'info',
            placement: 'top',
            title: item.title,
            subtitle: shorten(item.body),
            action: {
              label: item.link ? 'Open' : 'Mark as read',
              run: () => latest.current.open(item),
            },
          });
        }
      })
      .catch(() => undefined);
  }, [unread, queryClient]);
}
