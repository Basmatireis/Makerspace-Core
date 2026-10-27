import { Button, ProgressIndicator, ProgressStep } from '@carbon/react';
import { WarningFilled } from '@carbon/icons-react';
import type { AttendanceHold } from '../../../api/generated/models';
import { firstName, formatTime } from './format';
import { useReturnCountdown } from './useIdleCountdown';

const returnAfterSeconds = 30;

// Shown instead of the success screen: without signed, current Lab Rules the check-in is held until a supervisor
// confirms the signed paper document on the attendance page.
export function HoldScreen({ hold, onDone }: { hold: AttendanceHold; onDone: () => void }) {
  const left = useReturnCountdown(returnAfterSeconds, onDone);
  return (
    <div className="tablet-hold" role="alert">
      <div className="tablet-hold__banner">
        <WarningFilled size={48} aria-hidden="true" />
        <div>
          <p className="tablet-hold__eyebrow">Check-in on hold</p>
          <h1 className="tablet-hold__title">{firstName(hold.displayName)}, you are not checked in.</h1>
        </div>
      </div>

      <p className="tablet-hold__lead">
        {hold.previousRevision === null
          ? 'You have not signed the Lab Rules yet. Ask a supervisor for help.'
          : `The Lab Rules have changed (revision ${hold.requiredRevision ?? 'current'}). Please sign the new version — ask a supervisor for help.`}
      </p>

      <ProgressIndicator vertical currentIndex={1} className="tablet-hold__steps">
        <ProgressStep label="Check-in requested" secondaryLabel={`at ${formatTime(hold.requestedAt)}`} />
        <ProgressStep
          label="Sign the Lab Rules"
          secondaryLabel="Ask a supervisor for the paper document, read it and sign it."
        />
        <ProgressStep
          label="Supervisor confirms"
          secondaryLabel="They confirm your signature on the attendance page."
        />
        <ProgressStep label="Checked in" secondaryLabel="Happens automatically — no need to come back here." />
      </ProgressIndicator>

      <p className="tablet-hold__warning">Please don’t use any machines until then.</p>

      <Button size="2xl" kind="secondary" className="tablet-submit" onClick={onDone}>
        Understood · {left} s
      </Button>
    </div>
  );
}
