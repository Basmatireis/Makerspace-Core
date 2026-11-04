import { Button, Heading, InlineNotification } from '@carbon/react';
import { CheckmarkFilled } from '@carbon/icons-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../../branding/branding';
import { useCurrentUser } from '../../auth/auth';
import { LabRulesConfirmForm } from './LabRulesConfirmForm';
import './confirm.scss';

/**
 * Standalone page behind the "New Lab Rules" notification and e-mail: outside the application shell, so there is
 * no navigation to wander off to. Needs a session (the route sits behind ProtectedRoute).
 */
export default function LabRulesConfirmPage() {
  usePageTitle('Confirm the Lab Rules');
  const { laborordnungStatus: status } = useCurrentUser();
  const [confirmedRevision, setConfirmedRevision] = useState<string | null>(null);

  let body;
  if (confirmedRevision !== null) {
    body = (
      <>
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          role="status"
          title="Thank you"
          subtitle={`You confirmed revision ${confirmedRevision} of the Lab Rules.`}
        />
        <div>
          <Button as={Link} to="/dashboard" kind="secondary" renderIcon={CheckmarkFilled}>
            Open the app
          </Button>
        </div>
      </>
    );
  } else if (status.state === 'not_required') {
    body = <Info title="Nothing to confirm" text="Your account does not need to confirm the Lab Rules." />;
  } else if (status.state === 'no_published_version' || !status.currentVersion) {
    body = <Info title="No Lab Rules yet" text="No Lab Rules have been published yet. Nothing to confirm for now." />;
  } else if (!status.actionRequired) {
    body = (
      <Info
        title="Already confirmed"
        text={`You have already confirmed the current Lab Rules (revision ${status.currentVersion.humanRevision}).`}
      />
    );
  } else {
    body = (
      <>
        <p>
          Revision {status.currentVersion.humanRevision} of the Lab Rules is in effect. Read it and confirm that you
          agree to follow it.
        </p>
        <LabRulesConfirmForm
          version={status.currentVersion}
          onConfirmed={(v) => setConfirmedRevision(v.humanRevision)}
        />
      </>
    );
  }

  return (
    <main className="lab-rules-confirm-page">
      <Heading className="lab-rules-confirm-page__heading">Lab Rules</Heading>
      {body}
    </main>
  );
}

function Info({ title, text }: { title: string; text: string }) {
  return (
    <>
      <InlineNotification kind="info" lowContrast hideCloseButton role="status" title={title} subtitle={text} />
      <div>
        <Button as={Link} to="/dashboard" kind="secondary">
          Open the app
        </Button>
      </div>
    </>
  );
}
