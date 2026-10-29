import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { Notification } from '../../api/generated/models';
import { markNotificationRead } from '../../api/generated/notifications/notifications';
import { notificationKeys } from './queries';

/** A web address opens in a new tab; anything else is a path inside the application. */
export function isExternalLink(link: string): boolean {
  return link.startsWith('https://');
}

/**
 * Opens a notification: marks it read, then follows its link (a new tab for web addresses, the router for app paths).
 * Returns whether a link was followed.
 */
export function useOpenNotification(): (item: Pick<Notification, 'id' | 'link' | 'readAt'>) => boolean {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const markRead = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationKeys.all }),
  });
  return (item) => {
    if (!item.readAt) markRead.mutate(item.id);
    if (!item.link) return false;
    if (isExternalLink(item.link)) window.open(item.link, '_blank', 'noopener,noreferrer');
    else void navigate(item.link);
    return true;
  };
}
