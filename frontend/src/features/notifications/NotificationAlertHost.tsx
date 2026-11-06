import { lazy, Suspense, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unreadCountQuery } from './queries';

// Pop-ups, banners and dialogs pull in their views and styles only once the first one has to be shown.
const AlertViews = lazy(() => import('./AlertViews').then(({ AlertViews }) => ({ default: AlertViews })));

/**
 * Shows the notifications that appear on screen: the header's poll hands them over (no second poller) and the views
 * take care of pop-ups, banners and dialogs. Mounted once at the top of the main area.
 */
export function NotificationAlertHost() {
  const poll = useQuery(unreadCountQuery()).data;
  // Once something had to be shown, the views stay mounted: their pop-ups outlive the poll that brought them.
  const [wanted, setWanted] = useState(false);
  if (!wanted && poll && (poll.fresh.length > 0 || poll.pinned.length > 0)) setWanted(true);
  if (!wanted || !poll) return null;
  return (
    <Suspense fallback={null}>
      <AlertViews poll={poll} />
    </Suspense>
  );
}
