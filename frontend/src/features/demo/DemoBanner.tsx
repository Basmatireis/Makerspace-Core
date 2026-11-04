import { ActionableNotification } from '@carbon/react';
import { exitDemoMode, useDemoMode } from './demoMode';

/** Tells people they are working with sample data and offers the way out; renders nothing outside demo mode. */
export function DemoBanner() {
  const active = useDemoMode();
  if (!active) return null;
  return (
    <ActionableNotification
      inline
      lowContrast
      hideCloseButton
      role="status"
      kind="info"
      title="Demo mode"
      subtitle="You're working with sample data. Nothing you do here is saved."
      actionButtonLabel="Leave demo"
      onActionButtonClick={() => void exitDemoMode()}
    />
  );
}
