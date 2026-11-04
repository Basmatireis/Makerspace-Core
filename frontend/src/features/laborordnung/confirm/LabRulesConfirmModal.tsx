import { Button, Modal } from '@carbon/react';
import type { LaborordnungStatus } from '../../../api/generated/models';
import { LabRulesConfirmForm } from './LabRulesConfirmForm';

/**
 * Asks the signed-in person to confirm the current Lab Rules. In `blocking` mode it cannot be dismissed; in `warning`
 * mode "Later" closes it until the page is loaded again. Rendered only while `status.actionRequired` holds, and loaded
 * lazily so the PDF viewer stays out of the initial bundle.
 */
export default function LabRulesConfirmModal({ status, onLater }: { status: LaborordnungStatus; onLater: () => void }) {
  const version = status.currentVersion;
  if (!version) return null;
  const blocking = status.mode === 'blocking';
  return (
    <Modal
      open
      passiveModal
      size="lg"
      className={blocking ? 'lab-rules-modal lab-rules-modal--blocking' : 'lab-rules-modal'}
      modalHeading="Confirm the Lab Rules"
      modalLabel={`Lab Rules, revision ${version.humanRevision}`}
      preventCloseOnClickOutside
      // Escape, the overlay and the close button call this; blocking mode ignores all three (the button is hidden).
      onRequestClose={blocking ? undefined : onLater}
    >
      <p className="lab-rules-modal__lead">
        {blocking
          ? 'The Lab Rules changed. You need to confirm the current revision before you can be checked in.'
          : 'The Lab Rules changed. Please read the current revision and confirm it.'}
      </p>
      <LabRulesConfirmForm
        version={version}
        secondary={
          blocking ? undefined : (
            <Button kind="secondary" onClick={onLater}>
              Later
            </Button>
          )
        }
      />
    </Modal>
  );
}
