import { InlineNotification, Modal } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getPerson, promotePersonToSupervisor } from '../../api/generated/people/people';
import type { SupervisorRow } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { plural } from '../dashboard/format';

type Props = {
  member: SupervisorRow | null;
  threshold: number;
  onClose: () => void;
  onPromoted: (name: string) => void;
};

/**
 * Making a trainee a supervisor changes the person's roles, which is guarded by the person's version. The staffing
 * overview does not carry it, so the dialog reads the person right before promoting.
 */
export function PromoteDialog({ member, threshold, onClose, onPromoted }: Props) {
  const client = useQueryClient();
  const promote = useMutation({
    mutationFn: async (personId: string) => {
      const person = await getPerson(personId);
      return promotePersonToSupervisor(personId, { expectedVersion: person.version });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['supervisor-dashboard'] });
      if (member) onPromoted(member.name);
      onClose();
    },
  });
  const close = () => {
    promote.reset();
    onClose();
  };
  const firstName = member?.name.split(' ')[0] ?? '';

  return (
    <Modal
      open={member !== null}
      size="sm"
      modalHeading={`Make ${member?.name ?? ''} a supervisor?`}
      primaryButtonText={promote.isPending ? 'Saving…' : 'Make supervisor'}
      primaryButtonDisabled={promote.isPending}
      secondaryButtonText="Cancel"
      onRequestClose={close}
      onRequestSubmit={() => {
        if (member) promote.mutate(member.personId);
      }}
    >
      {member && (
        <>
          <p>
            {firstName} has staffed {plural(member.staffedAsTrainee, 'open day')} as trainee
            {member.staffedAsTrainee < threshold ? ` (the usual threshold is ${threshold})` : ''}. Their role changes to
            supervisor: they take supervisor places and the open days they already did still count towards this
            semester’s minimum.
          </p>
          {promote.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Not changed"
              subtitle={
                promote.error instanceof ApiError ? promote.error.message : 'Check the connection and try again.'
              }
            />
          )}
        </>
      )}
    </Modal>
  );
}
