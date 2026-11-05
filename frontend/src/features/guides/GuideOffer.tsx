import { useState } from 'react';
import { ActionableNotification } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { useCurrentUser } from '../auth/auth';
import { useGuides } from './GuideProvider';
import { useGuideProgress, useUpdateGuideProgress } from './progress';
import { loadGuides } from './registry';
import { useAppOverlay } from './useGuideTarget';

export const WELCOME_GUIDE_ID = 'welcome';

/**
 * Offers the welcome tour once per account and, once that is settled, the tour of an area on the area's pages until
 * it is finished or dismissed; on a normal staff session only. Mounted by the app shell.
 */
export default function GuideOffer() {
  const currentUser = useCurrentUser();
  const { pathname } = useLocation();
  const { activeGuideId, startGuide } = useGuides();
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const update = useUpdateGuideProgress();
  const eligible =
    currentUser.managedDevice === null && currentUser.session.postSessionDestination !== 'visitor_terminal';
  // Only people the offer is for ask the server.
  const progress = useGuideProgress(eligible);
  const settled = new Set(progress.data?.items.map((item) => item.guideId));
  const welcomeSettled = settled.has(WELCOME_GUIDE_ID);
  // The guide definitions are their own chunk; they load only for someone past the welcome offer.
  const registry = useQuery({
    queryKey: ['guides', 'registry'],
    queryFn: loadGuides,
    staleTime: Infinity,
    enabled: eligible && welcomeSettled,
  });
  // The toast sits at the bottom of the screen; it waits while a dialog or header panel is open so it never covers
  // their buttons.
  const overlay = useAppOverlay();

  const offer = !progress.data
    ? undefined
    : !welcomeSettled
      ? { id: WELCOME_GUIDE_ID, title: 'New here?', subtitle: 'Take a quick tour of the app.' }
      : registry.data
          ?.filter((guide) => guide.suggestOn?.test(pathname) && !settled.has(guide.id) && guide.requires(currentUser))
          .map((guide) => ({
            id: guide.id,
            title: `New to ${guide.title.replace(/ tour$/, '')}?`,
            subtitle: guide.summary,
          }))[0];

  if (!eligible || !offer || hiddenIds.includes(offer.id) || overlay !== null || activeGuideId !== null) {
    return null;
  }

  const hide = () => setHiddenIds((ids) => [...ids, offer.id]);
  return (
    <div className="app-toasts app-toasts--bottom" aria-live="polite">
      <ActionableNotification
        key={offer.id}
        kind="info"
        lowContrast
        hasFocus={false}
        role="status"
        title={offer.title}
        subtitle={offer.subtitle}
        actionButtonLabel="Start tour"
        onActionButtonClick={() => {
          hide();
          startGuide(offer.id);
        }}
        aria-label="Not now"
        onClose={() => {
          hide();
          update.mutate({ guideId: offer.id, status: 'dismissed' });
          return false;
        }}
        closeOnEscape={false}
        inline={false}
      />
    </div>
  );
}
