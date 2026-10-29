import { lazy, Suspense, useRef, useState, type RefObject } from 'react';
import { HeaderPanel, IconButton } from '@carbon/react';
import { Notification } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { unreadCountQuery } from './queries';
import { useNewNotificationToasts } from './useNewNotificationToasts';

// The list pulls in the list, tag and relative-time code, so it loads when the panel is first opened.
const NotificationList = lazy(() =>
  import('./NotificationList').then(({ NotificationList }) => ({ default: NotificationList })),
);

type ActionProps = {
  expanded: boolean;
  actionRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
};

/** The header bell with the unread badge. Polls the unread count; the badge is hidden at zero. */
export function NotificationAction({ expanded, actionRef, onToggle }: ActionProps) {
  const unread = useQuery(unreadCountQuery()).data?.unreadCount ?? 0;
  useNewNotificationToasts();
  const label = `${expanded ? 'Close' : 'Open'} notifications${unread > 0 ? `, ${unread} unread` : ''}`;
  // HeaderGlobalAction has no badge; Carbon's IconButton does (ghost, large), and the header action class gives it
  // the same look and the active state as the profile action next to it.
  return (
    <IconButton
      label={label}
      kind="ghost"
      size="lg"
      align="bottom-end"
      className={`cds--header__action${expanded ? ' cds--header__action--active' : ''}`}
      ref={actionRef}
      badgeCount={unread > 0 ? unread : undefined}
      onClick={onToggle}
    >
      <Notification size={20} />
    </IconButton>
  );
}

type PanelProps = {
  expanded: boolean;
  actionRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
};

/** The notification panel below the header. Its content is loaded and fetched once it has been opened. */
export function NotificationPanel({ expanded, actionRef, onClose }: PanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [everOpened, setEverOpened] = useState(expanded);
  if (expanded && !everOpened) setEverOpened(true);
  return (
    <HeaderPanel
      expanded={expanded}
      className="notification-panel"
      aria-label="Notifications"
      // Carbon forwards extra attributes to the panel's div but does not type `role`; a label needs a role (axe).
      {...{ role: 'region' }}
      ref={panelRef}
      onHeaderPanelFocus={() => {
        // Focus left the panel (Escape or tabbing out): close it and, when it was inside, return it to the bell.
        const restoreFocus = panelRef.current?.contains(document.activeElement);
        onClose();
        if (restoreFocus) actionRef.current?.focus();
      }}
    >
      {everOpened && (
        <Suspense fallback={null}>
          <NotificationList active={expanded} onNavigate={onClose} />
        </Suspense>
      )}
    </HeaderPanel>
  );
}
