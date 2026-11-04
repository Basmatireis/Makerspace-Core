import { ActionableNotification, Button, Tile } from '@carbon/react';
import { ArrowRight, CheckmarkFilled, Document, WarningAltFilled } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import type { LaborordnungStatus } from '../../api/generated/models';

const confirmPath = '/lab-rules/confirm';

/** Shown when a version is unconfirmed; people who chose "Later" in the dialog get back to it from here. */
export function LabRulesNotice({ status }: { status: LaborordnungStatus }) {
  const navigate = useNavigate();
  if (!status.actionRequired) return null;
  return (
    <ActionableNotification
      kind="warning"
      lowContrast
      inline
      role="status"
      hideCloseButton
      title="New Lab Rules"
      subtitle="Read the current Lab Rules and confirm them."
      actionButtonLabel="Read and confirm"
      onActionButtonClick={() => void navigate(confirmPath)}
    />
  );
}

/** Guests mostly log in to check their Lab Rules status before an open day. */
export function LabRulesTile({ status }: { status: LaborordnungStatus }) {
  const revision = status.currentVersion?.humanRevision;
  let body;
  if (status.state === 'not_required') {
    body = (
      <>
        <p className="db-tile__title db-status db-status--ok db-status--title">
          <CheckmarkFilled size={24} aria-hidden />
          Nothing to confirm
        </p>
        <p className="db-tile__meta">Confirming the Lab Rules is not required for your account.</p>
      </>
    );
  } else if (status.state === 'no_published_version') {
    body = <p className="db-tile__meta">No Lab Rules have been published yet.</p>;
  } else if (status.state === 'current') {
    body = (
      <>
        <p className="db-tile__title db-status db-status--ok db-status--title">
          <CheckmarkFilled size={24} aria-hidden />
          Confirmed
        </p>
        <p className="db-tile__meta">
          You confirmed the current Lab Rules{revision ? ` (revision ${revision})` : ''}. You can use the machines with
          a supervisor at any open day.
        </p>
      </>
    );
  } else {
    body = (
      <>
        <p className="db-tile__title db-status db-status--warning db-status--title">
          <WarningAltFilled size={24} aria-hidden />
          Not confirmed yet
        </p>
        <p className="db-tile__meta">
          Read the current Lab Rules{revision ? ` (revision ${revision})` : ''} and confirm them with a checkbox. It
          takes a minute.
        </p>
      </>
    );
  }
  return (
    <Tile className="db-tile">
      <span className="db-tile__eyebrow">
        <Document size={16} aria-hidden />
        Lab Rules
      </span>
      {body}
      {status.actionRequired && (
        <div className="db-tile__actions">
          <Button as={Link} to={confirmPath} kind="ghost" size="sm" renderIcon={ArrowRight}>
            Read and confirm
          </Button>
        </div>
      )}
    </Tile>
  );
}
