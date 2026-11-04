import { Button, InlineNotification } from '@carbon/react';
import { ArrowLeft } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { getGetTerminalLabRulesPDFUrl, getTerminalLabRules } from '../../../api/generated/attendance/attendance';
import type { Visit } from '../../../api/generated/models';
import { useSecretMutation } from '../../../api/use-secret-mutation';
import { ErrorState, InlineLoadingState } from '../../../app/PageState';
import { LabRulesAgreement } from '../../laborordnung/confirm/LabRulesAgreement';
import { isLabRulesVersionOutdated } from '../../laborordnung/confirm/useConfirmOwnLabRules';
import { checkIn, type Credentials, type LabRulesChoice, type LabRulesNeed } from './checkIn';
import { useIdleCountdown } from './useIdleCountdown';

// Reading takes longer than typing a PIN; any touch still restarts the countdown.
const idleSeconds = 120;

const kioskLabRulesKey = ['kiosk', 'lab-rules'] as const;

/**
 * Shown after PIN or password when the person has not confirmed the current Lab Rules. They read the rules, tick the
 * box and are checked in with the same entries (kept in memory only until this screen is left). A role that merely
 * warns may also choose "Later".
 */
export function LabRulesScreen({
  credentials,
  need,
  onSuccess,
  onCancel,
}: {
  credentials: Credentials;
  need: LabRulesNeed;
  onSuccess: (visit: Visit) => void;
  /** Leaves without checking in; the parent drops the credentials. */
  onCancel: () => void;
}) {
  const rules = useQuery({
    queryKey: kioskLabRulesKey,
    queryFn: ({ signal }) => getTerminalLabRules({ signal }),
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  const [checked, setChecked] = useState(false);
  const [outdated, setOutdated] = useState(false);
  const idleLeft = useIdleCountdown(onCancel, idleSeconds);
  const submit = useSecretMutation((choice: LabRulesChoice): Promise<Visit> => checkIn(credentials, choice));

  async function send(choice: LabRulesChoice) {
    setOutdated(false);
    try {
      onSuccess(await submit.mutateAsync(choice));
    } catch (error) {
      if (isLabRulesVersionOutdated(error)) {
        // A newer revision became effective while the person was reading: show it and ask again.
        setChecked(false);
        setOutdated(true);
        await rules.refetch();
      }
    }
  }

  const back = (
    <Button kind="ghost" size="lg" renderIcon={ArrowLeft} iconDescription="Back" onClick={onCancel}>
      Back
    </Button>
  );

  if (rules.isPending) {
    return (
      <div className="tablet-rules">
        {back}
        <InlineLoadingState label="Loading the Lab Rules" />
      </div>
    );
  }
  if (rules.isError) {
    return (
      <div className="tablet-rules">
        {back}
        <ErrorState
          title="The Lab Rules are unavailable"
          message="Try again, or ask a supervisor to check you in."
          onRetry={() => void rules.refetch()}
        />
      </div>
    );
  }

  const version = rules.data;
  const failure = submit.isError && !isLabRulesVersionOutdated(submit.error) ? submit.error.message : null;
  return (
    <div className="tablet-rules">
      <div className="tablet-identify__header">{back}</div>
      <h1 className="tablet-identify__title">Lab Rules, revision {version.humanRevision}</h1>
      <p className="tablet-rules__lead">
        {need === 'blocking'
          ? 'Read the Lab Rules and confirm them to be checked in.'
          : 'The Lab Rules changed. Please read them and confirm, or do it later.'}
      </p>
      {outdated && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          role="alert"
          title="The Lab Rules changed"
          subtitle="A newer revision became effective while you were reading. Please read the new revision."
        />
      )}
      {failure && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Check-in failed" subtitle={failure} />
      )}
      <LabRulesAgreement
        id="tablet-lab-rules-agree"
        revision={version.humanRevision}
        pdfUrl={getGetTerminalLabRulesPDFUrl()}
        checked={checked}
        onCheckedChange={setChecked}
        disabled={submit.isPending}
        size="lg"
      >
        <div className="tablet-rules__actions">
          <Button
            size="2xl"
            className="tablet-submit"
            disabled={!checked || submit.isPending}
            onClick={() => void send({ confirmVersionId: version.id })}
          >
            Confirm and check in
          </Button>
          {need === 'warning' && (
            <Button
              size="2xl"
              kind="secondary"
              className="tablet-submit"
              disabled={submit.isPending}
              onClick={() => void send({ defer: true })}
            >
              Later
            </Button>
          )}
        </div>
      </LabRulesAgreement>
      <p className="tablet-identify__idle">
        {idleLeft <= 30
          ? `No activity — returning to the start screen in ${idleLeft} s.`
          : 'Your entries are cleared when you leave this screen.'}
      </p>
    </div>
  );
}
