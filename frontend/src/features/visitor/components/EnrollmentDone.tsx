import { Button } from '@carbon/react';
import { CheckmarkFilled } from '@carbon/icons-react';
import { useReturnCountdown } from '../../kiosk/components/useIdleCountdown';

const returnAfterSeconds = 30;

export type EnrollmentOutcome = {
  firstName: string;
  email: string;
  labRulesConfirmed: boolean;
};

// Shown after the submission; returns to the kiosk on its own.
export function EnrollmentDone({ outcome, onDone }: { outcome: EnrollmentOutcome; onDone: () => void }) {
  const left = useReturnCountdown(returnAfterSeconds, onDone);
  return (
    <div className="visitor-done">
      <div className="visitor-done__banner">
        <CheckmarkFilled size={48} aria-hidden="true" />
        <div>
          <p className="visitor-done__eyebrow">Registration complete</p>
          <h1 className="visitor-done__title" tabIndex={-1} ref={(node) => node?.focus()}>
            {outcome.firstName}, your account is ready.
          </h1>
        </div>
      </div>

      <div className="visitor-done__grid">
        <div className="visitor-done__column">
          <h2 className="visitor-done__heading">You are checked in</h2>
          <p className="visitor-done__lead">
            {outcome.labRulesConfirmed ? 'You confirmed the Lab Rules and are checked in.' : 'You are checked in.'} Have
            fun in the lab.
          </p>
        </div>
        <div className="visitor-done__column">
          <h2 className="visitor-done__heading">How you sign in</h2>
          <p className="visitor-done__lead">
            Next time, choose <strong>Email code</strong> at the check-in screen, enter <strong>{outcome.email}</strong>{' '}
            and the six-digit code we email you.
          </p>
        </div>
      </div>

      <Button size="2xl" className="visitor-done__button" onClick={onDone}>
        Done · {left} s
      </Button>
    </div>
  );
}
