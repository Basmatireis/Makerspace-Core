import { Button, InlineNotification, ProgressIndicator, ProgressStep } from '@carbon/react';
import { CheckmarkFilled } from '@carbon/icons-react';
import { useReturnCountdown } from '../../kiosk/components/useIdleCountdown';

const returnAfterSeconds = 30;

export type EnrollmentOutcome = {
  firstName: string;
  admission: string;
  attendance: 'checked_in' | 'awaiting_sign_off';
  invitationDelivery: 'sent' | 'failed' | null | undefined;
  method: 'password' | 'pin';
  email: string;
  loginName: string;
};

// Shown after the submission, in the style of the kiosk's hold screen; returns to the kiosk on its own.
export function EnrollmentDone({ outcome, onDone }: { outcome: EnrollmentOutcome; onDone: () => void }) {
  const left = useReturnCountdown(returnAfterSeconds, onDone);
  const blocked = outcome.admission === 'blocked';
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
          <h2 className="visitor-done__heading">{blocked ? 'One more step before you start' : 'You are checked in'}</h2>
          <p className="visitor-done__lead">
            {blocked
              ? 'You are waiting at the entrance. Ask a supervisor for the paper Lab Rules, read them and sign. You will be checked in automatically once a supervisor confirms your signed Lab Rules, so you do not need to check in again. Please do not use any machines until then.'
              : outcome.admission === 'warning'
                ? 'You are checked in. Please sign the paper Lab Rules with a supervisor soon.'
                : 'You are checked in.'}
          </p>
          {blocked && (
            <ProgressIndicator vertical currentIndex={1} className="visitor-done__steps">
              <ProgressStep label="Account created" secondaryLabel="You can sign in on this kiosk." />
              <ProgressStep label="Sign the Lab Rules" secondaryLabel="Together with a supervisor, on paper." />
              <ProgressStep label="Supervisor confirms" secondaryLabel="They record your signature." />
              <ProgressStep label="Checked in" secondaryLabel="Happens automatically." />
            </ProgressIndicator>
          )}
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
