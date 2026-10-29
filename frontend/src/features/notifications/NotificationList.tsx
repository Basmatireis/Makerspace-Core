import {
  Button,
  ContainedList,
  ContainedListItem,
  IconButton,
  InlineNotification,
  SkeletonText,
  Tag,
} from '@carbon/react';
import { Close } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Notification } from '../../api/generated/models';
import { dismissNotification, markAllNotificationsRead } from '../../api/generated/notifications/notifications';
import { useNow } from '../../app/useNow';
import { useOpenNotification } from './openNotification';
import { notificationKeys, notificationListQuery, PANEL_PAGE_SIZE } from './queries';
import { relativeTime } from './relativeTime';

type Props = {
  /** The panel is open; the list is only fetched (and refreshed on each opening) while it is. */
  active: boolean;
  /** Called after navigating to a notification's link, so the panel closes. */
  onNavigate: () => void;
};

/** The own notifications, newest first: open one (marks it read and follows its link), dismiss, mark all read. */
export function NotificationList({ active, onNavigate }: Props) {
  const queryClient = useQueryClient();
  const openNotification = useOpenNotification();
  const now = useNow();
  const query = useQuery({ ...notificationListQuery(), enabled: active });
  const refresh = () => queryClient.invalidateQueries({ queryKey: notificationKeys.all });
  const markAll = useMutation({ mutationFn: () => markAllNotificationsRead(), onSettled: refresh });
  const dismiss = useMutation({ mutationFn: (id: string) => dismissNotification(id), onSettled: refresh });

  const open = (item: Notification) => {
    if (openNotification(item)) onNavigate();
  };

  if (query.isPending) return <SkeletonText paragraph lineCount={4} />;
  if (query.isError) {
    return (
      <InlineNotification
        kind="error"
        lowContrast
        hideCloseButton
        title="Notifications could not be loaded"
        subtitle="Try again later."
      />
    );
  }
  const { items, total, unreadCount } = query.data;
  const failed = markAll.isError || dismiss.isError;
  return (
    <div className="notification-panel__content">
      <div className="notification-panel__toolbar">
        <h2 className="notification-panel__title">Notifications</h2>
        <Button
          kind="ghost"
          size="sm"
          disabled={unreadCount === 0 || markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          Mark all as read
        </Button>
      </div>
      {failed && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="That did not work"
          subtitle="Check the connection and try again."
        />
      )}
      {items.length === 0 ? (
        <p className="notification-panel__empty">You have no notifications.</p>
      ) : (
        <ContainedList label="Your notifications" kind="disclosed" isInset>
          {items.map((item) => (
            <ContainedListItem
              key={item.id}
              onClick={() => open(item)}
              action={
                <IconButton
                  kind="ghost"
                  size="sm"
                  label={`Dismiss notification: ${item.title}`}
                  align="left"
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(item.id)}
                >
                  <Close />
                </IconButton>
              }
            >
              <div className="notification-item">
                <span className="notification-item__heading">
                  {!item.readAt && (
                    <Tag size="sm" type="blue">
                      New
                    </Tag>
                  )}
                  <strong className="notification-item__title">{item.title}</strong>
                </span>
                <span className="notification-item__body">{item.body}</span>
                <span className="notification-item__time">{relativeTime(item.createdAt, now)}</span>
              </div>
            </ContainedListItem>
          ))}
        </ContainedList>
      )}
      {total > PANEL_PAGE_SIZE && (
        <p className="notification-panel__note">
          Showing the latest {PANEL_PAGE_SIZE} of {total} notifications.
        </p>
      )}
    </div>
  );
}
