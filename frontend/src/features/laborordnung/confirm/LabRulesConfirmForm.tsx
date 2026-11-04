import { Button, InlineNotification } from '@carbon/react';
import { useState, type ReactNode } from 'react';
import { getGetLaborordnungPDFUrl } from '../../../api/generated/laborordnung/laborordnung';
import type { LaborordnungVersion } from '../../../api/generated/models';
import { LabRulesAgreement } from './LabRulesAgreement';
import { isLabRulesVersionOutdated, useConfirmOwnLabRules } from './useConfirmOwnLabRules';

/**
 * Lab Rules PDF, agreement checkbox and Confirm button for the signed-in person. `secondary` adds a button beside
 * Confirm (the modal's "Later"). Remounts per revision, so a newer version starts with an unchecked box.
 */
export function LabRulesConfirmForm({
  version,
  secondary,
  onConfirmed,
}: {
  version: LaborordnungVersion;
  secondary?: ReactNode;
  onConfirmed?: (version: LaborordnungVersion) => void;
}) {
  // The mutation lives outside the remounting body so that "the rules changed" outlives the switch to the new revision.
  const confirm = useConfirmOwnLabRules();
  return (
    <ConfirmFormBody
      key={version.id}
      version={version}
      confirm={confirm}
      secondary={secondary}
      onConfirmed={onConfirmed}
    />
  );
}

function ConfirmFormBody({
  version,
  confirm,
  secondary,
  onConfirmed,
}: {
  version: LaborordnungVersion;
  confirm: ReturnType<typeof useConfirmOwnLabRules>;
  secondary?: ReactNode;
  onConfirmed?: (version: LaborordnungVersion) => void;
}) {
  const [checked, setChecked] = useState(false);
  const outdated = confirm.isError && isLabRulesVersionOutdated(confirm.error);

  return (
    <LabRulesAgreement
      id="lab-rules-confirm-agree"
      revision={version.humanRevision}
      pdfUrl={getGetLaborordnungPDFUrl(version.id)}
      checked={checked}
      onCheckedChange={setChecked}
      disabled={confirm.isPending}
    >
      {confirm.isError && (
        <InlineNotification
          kind={outdated ? 'warning' : 'error'}
          lowContrast
          hideCloseButton
          role="alert"
          title={outdated ? 'The Lab Rules changed' : 'Confirmation failed'}
          subtitle={
            outdated
              ? 'A newer revision became effective while you were reading. Please read the new revision.'
              : confirm.error.message
          }
        />
      )}
      <div className="lab-rules-agreement__actions">
        <Button
          kind="primary"
          disabled={!checked || confirm.isPending}
          onClick={() =>
            confirm.mutate(version.id, {
              onSuccess: () => onConfirmed?.(version),
            })
          }
        >
          {confirm.isPending ? 'Confirming…' : 'Confirm'}
        </Button>
        {secondary}
      </div>
    </LabRulesAgreement>
  );
}
