import { useState } from 'react';
import { ActionableNotification, Button } from '@carbon/react';
import { useCurrentUser } from '../auth/auth';
import { useGuides } from './GuideProvider';
import { useGuideProgress, useUpdateGuideProgress } from './progress';

export const WELCOME_GUIDE_ID = 'welcome';

/** Offers the welcome tour once per account, on a normal staff session only. Mounted by the app shell. */
export default function GuideOffer() {
  const currentUser = useCurrentUser();
  const { activeGuideId, startGuide } = useGuides();
  const [hidden, setHidden] = useState(false);
  const update = useUpdateGuideProgress();
  const eligible =
    currentUser.managedDevice === null && currentUser.session.postSessionDestination !== 'visitor_terminal';
  // Only people the offer is for ask the server.
  const progress = useGuideProgress(eligible);

  if (
    !eligible ||
    hidden ||
    activeGuideId !== null ||
    !progress.data ||
    progress.data.items.some((item) => item.guideId === WELCOME_GUIDE_ID)
  ) {
    return null;
  }

  return (
    <div className="app-toasts app-toasts--bottom" aria-live="polite">
      <ActionableNotification
        kind="info"
        lowContrast
        hasFocus={false}
        role="status"
        title="New here?"
        subtitle="Take a quick tour of the app."
        actionButtonLabel="Start tour"
        onActionButtonClick={() => {
          setHidden(true);
          startGuide(WELCOME_GUIDE_ID);
        }}
        onClose={() => false}
        closeOnEscape={false}
        hideCloseButton
        inline={false}
      >
        <Button
          kind="ghost"
          size="sm"
          onClick={() => {
            setHidden(true);
            update.mutate({ guideId: WELCOME_GUIDE_ID, status: 'dismissed' });
          }}
        >
          Not now
        </Button>
      </ActionableNotification>
    </div>
  );
}
