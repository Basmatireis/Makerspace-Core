import { ActionableNotification, Button, InlineNotification, Tile } from '@carbon/react';
import { ArrowRight, CheckmarkFilled, Document, WarningAltFilled } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { requestOwnLaborordnungConfirmation } from '../../api/generated/laborordnung/laborordnung';
import type { LaborordnungStatus } from '../../api/generated/models';
import { dashboardKeys } from './queries';

function useRequestSignature() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => requestOwnLaborordnungConfirmation(),
    onSuccess: () => client.invalidateQueries({ queryKey: dashboardKeys.labRules() }),
  });
}

/** Shown to staff only when a new version is unsigned or a signature was requested. */
export function LabRulesNotice({ status }: { status: LaborordnungStatus }) {
  const request = useRequestSignature();
  if (!status.actionRequired) return null;
  if (status.requestId !== null) {
    return (
      <InlineNotification
        kind="info"
        lowContrast
        hideCloseButton
        title="Lab rules signature requested"
        subtitle="Sign the printed lab rules with another supervisor; they confirm it in the app."
      />
    );
  }
  return (
    <ActionableNotification
      kind="warning"
      lowContrast
      inline
      role="status"
      hideCloseButton
      title="New lab rules"
      subtitle="The lab rules changed. Sign the new version with another supervisor before you use machines again."
      actionButtonLabel={request.isPending ? 'Requesting…' : 'Request signature'}
      onActionButtonClick={() => request.mutate()}
    />
  );
}

/** Guests mostly log in to check their lab rules status before an open day. */
export function LabRulesTile({ status }: { status: LaborordnungStatus }) {
  const request = useRequestSignature();
  const revision = status.currentVersion?.humanRevision;
  let body;
  if (status.state === 'not_required') {
    body = (
      <>
        <p className="db-tile__title db-status db-status--ok db-status--title">
          <CheckmarkFilled size={24} aria-hidden />
          Nothing to sign
        </p>
        <p className="db-tile__meta">Signing the lab rules is not required for your account.</p>
      </>
    );
  } else if (status.state === 'no_published_version') {
    body = <p className="db-tile__meta">No lab rules have been published yet.</p>;
  } else if (status.state === 'current') {
    body = (
      <>
        <p className="db-tile__title db-status db-status--ok db-status--title">
          <CheckmarkFilled size={24} aria-hidden />
          Signed
        </p>
        <p className="db-tile__meta">
          You signed the current lab rules{revision ? ` (${revision})` : ''}. You can use the machines with a supervisor
          at any open day.
        </p>
      </>
    );
  } else {
    body = (
      <>
        <p className="db-tile__title db-status db-status--warning db-status--title">
          <WarningAltFilled size={24} aria-hidden />
          Not signed yet
        </p>
        <p className="db-tile__meta">
          {status.requestId !== null ? 'Your signature is requested. ' : ''}
          Sign the printed version{revision ? ` (${revision})` : ''} with a supervisor at the start of your next open
          day. Bring your student ID.
        </p>
      </>
    );
  }
  return (
    <Tile className="db-tile">
      <span className="db-tile__eyebrow">
        <Document size={16} aria-hidden />
        Lab rules
      </span>
      {body}
      {status.actionRequired && status.requestId === null && (
        <div className="db-tile__actions">
          <Button kind="ghost" size="sm" renderIcon={ArrowRight} onClick={() => request.mutate()}>
            {request.isPending ? 'Requesting…' : 'Request signature'}
          </Button>
        </div>
      )}
    </Tile>
  );
}
