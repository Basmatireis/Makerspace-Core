import { useState } from 'react';
import { InlineNotification, Modal, TextArea } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Membership, SupervisorRow } from '../../api/generated/models';
import { changePersonMembership } from '../../api/generated/people/people';
import { setStaffingExcusal } from '../../api/generated/supervisors/supervisors';
import { ApiError } from '../../api/http-client';
import { membershipLabel } from './staffing';
import { staffingKeys } from './staffingQueries';

const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Check the connection and try again.';

/** What a change of the membership system role means for the person, in the dialog's words. */
function membershipConsequence(row: SupervisorRow, target: Membership): string {
  const first = row.name.split(' ')[0];
  if (target === 'visitor')
    return `${first} stops staffing open days: they lose their supervisor or trainee places, their upcoming open-day assignments are removed and they no longer have a minimum. Extra roles stay.`;
  if (target === 'supervisor')
    return `${first} takes supervisor places from now on and the open days already staffed still count towards this semester's minimum. Extra roles stay.`;
  return `${first} takes trainee places from now on. Extra roles stay.`;
}

/** Changing the membership is guarded by the person's version that the overview row carries. */
export function MembershipDialog({
  member,
  target,
  onClose,
  onChanged,
}: {
  member: SupervisorRow | null;
  target: Membership | null;
  onClose: () => void;
  onChanged: (message: string) => void;
}) {
  const client = useQueryClient();
  const change = useMutation({
    mutationFn: (request: { row: SupervisorRow; membership: Membership }) =>
      changePersonMembership(request.row.personId, {
        membership: request.membership,
        expectedVersion: request.row.personVersion,
      }),
    onSuccess: async (_result, request) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: staffingKeys.dashboards }),
        client.invalidateQueries({ queryKey: ['open-days'] }),
        client.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      onChanged(`${request.row.name} is now ${membershipLabel(request.membership).toLowerCase()}`);
      onClose();
    },
  });
  const close = () => {
    change.reset();
    onClose();
  };
  const open = member !== null && target !== null;
  const label = target ? membershipLabel(target) : '';

  return (
    <Modal
      open={open}
      size="sm"
      modalHeading={`Make ${member?.name ?? ''} a ${label.toLowerCase()}?`}
      primaryButtonText={change.isPending ? 'Saving…' : `Make ${label.toLowerCase()}`}
      primaryButtonDisabled={change.isPending}
      danger={target === 'visitor'}
      secondaryButtonText="Cancel"
      onRequestClose={close}
      onRequestSubmit={() => {
        if (member && target) change.mutate({ row: member, membership: target });
      }}
    >
      {member && target && (
        <>
          <p>{membershipConsequence(member, target)}</p>
          {change.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Not changed"
              subtitle={errorText(change.error)}
            />
          )}
        </>
      )}
    </Modal>
  );
}

const REASON_LIMIT = 500;

/** Excusing a person sets their minimum for this semester to zero; the reason is for the Leitung only. */
export function ExcuseDialog({
  member,
  periodId,
  periodName,
  onClose,
  onExcused,
}: {
  member: SupervisorRow | null;
  periodId: string | null;
  periodName: string;
  onClose: () => void;
  onExcused: (message: string) => void;
}) {
  const client = useQueryClient();
  const [reason, setReason] = useState('');
  const excuse = useMutation({
    mutationFn: (request: { row: SupervisorRow; periodId: string; reason: string }) =>
      setStaffingExcusal(request.periodId, request.row.personId, { reason: request.reason }),
    onSuccess: async (_result, request) => {
      await client.invalidateQueries({ queryKey: staffingKeys.dashboards });
      onExcused(`${request.row.name} is excused for ${periodName}`);
      close();
    },
  });
  function close() {
    excuse.reset();
    setReason('');
    onClose();
  }
  const tooLong = reason.length > REASON_LIMIT;

  return (
    <Modal
      open={member !== null && periodId !== null}
      size="sm"
      modalHeading={`Excuse ${member?.name ?? ''} for ${periodName}?`}
      primaryButtonText={excuse.isPending ? 'Saving…' : 'Excuse'}
      primaryButtonDisabled={excuse.isPending || tooLong}
      secondaryButtonText="Cancel"
      onRequestClose={close}
      onRequestSubmit={() => {
        if (member && periodId && !tooLong) excuse.mutate({ row: member, periodId, reason: reason.trim() });
      }}
    >
      <p>
        An excused person has no open-day minimum for this semester and never counts as below it. Open days they staff
        still count.
      </p>
      <TextArea
        id="staffing-excuse-reason"
        labelText="Reason (optional)"
        helperText="Only people who see the staffing overview can read it."
        rows={3}
        value={reason}
        invalid={tooLong}
        invalidText={`Use at most ${REASON_LIMIT} characters.`}
        onChange={(event) => setReason(event.target.value)}
      />
      {excuse.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not excused"
          subtitle={errorText(excuse.error)}
        />
      )}
    </Modal>
  );
}
