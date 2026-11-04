import { Button, InlineNotification } from '@carbon/react';
import { CheckmarkFilled } from '@carbon/icons-react';
import { useReturnCountdown } from '../../kiosk/components/useIdleCountdown';

const returnAfterSeconds = 30;

export type EnrollmentOutcome = {
  firstName: string;
  invitationDelivery: 'sent' | 'failed' | null | undefined;
  method: 'password' | 'pin';
  email: string;
  loginName: string;
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
          <p className="visitor-done__lead">You confirmed the Lab Rules and are checked in. Have fun in the lab.</p>
        </div>
        <div className="visitor-done__column">
          <h2 className="visitor-done__heading">How you sign in</h2>
          {outcome.method === 'pin' ? (
            <p className="visitor-done__lead">
              Use your login name <strong>{outcome.loginName}</strong> and your PIN at the check-in screen.
            </p>
          ) : outcome.invitationDelivery === 'sent' ? (
            <p className="visitor-done__lead">
              We sent an invitation to <strong>{outcome.email}</strong>. Open it to choose your password.
            </p>
          ) : (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Invitation not delivered"
              subtitle="The password invitation could not be sent. Ask an administrator to resend it."
            />
          )}
        </div>
      </div>

      <Button size="2xl" className="visitor-done__button" onClick={onDone}>
        Done · {left} s
      </Button>
    </div>
  );
}
