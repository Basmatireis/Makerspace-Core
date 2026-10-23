import {
  Button,
  ComposedModal,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  TextArea,
} from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { voidVisit } from '../../../api/generated/attendance/attendance';
import type { Visit } from '../../../api/generated/models';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { attendanceKeys } from '../queries';

export function VoidVisitDialog({ visit, onClose }: { visit: Visit | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const voidMutation = useMutation({
    mutationFn: ({ target, text }: { target: Visit; text: string }) =>
      voidVisit(target.id, { expectedVersion: target.version, reason: text }),
    onSuccess: async () => {
      finish();
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
    },
  });
  function finish() {
    setReason('');
    voidMutation.reset();
    onClose();
  }
  const close = useLatestCallback(() => {
    if (!voidMutation.isPending) finish();
    return false;
  });

  return (
    <ComposedModal
      open={Boolean(visit)}
      danger
      size="sm"
      selectorPrimaryFocus=".cds--btn--secondary"
      preventCloseOnClickOutside
      onClose={close}
    >
      <ModalHeader title={`Void attendance record for ${visit?.displayName ?? ''}?`} />
      <ModalBody>
        <Stack gap={5}>
          <p>
            The visit will be marked void and removed from current presence. Pending post-visit survey invitations are
            cancelled. The correction and its audit history remain recorded.
          </p>
          <TextArea
            id="void-visit-reason"
            labelText="Correction reason"
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          {voidMutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Attendance record not voided"
              subtitle={voidMutation.error.message}
            />
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={voidMutation.isPending} onClick={close}>
          Cancel
        </Button>
        <Button
          kind="danger"
          disabled={!reason.trim() || voidMutation.isPending}
          onClick={() => visit && voidMutation.mutate({ target: visit, text: reason.trim() })}
        >
          {voidMutation.isPending ? 'Voiding…' : 'Void record'}
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}
