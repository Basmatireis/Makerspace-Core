import { IconButton, InlineNotification, Modal } from '@carbon/react';
import { Logout } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ComingUpItem } from '../../api/generated/models';
import { leaveOpenDay } from '../../api/generated/open-days/open-days';
import { when } from './format';
import { dashboardKeys } from './queries';

/** The small door icon next to an open day the person holds. */
export function LeaveButton({ item, now, onLeave }: { item: ComingUpItem; now: number; onLeave: () => void }) {
  return (
    <IconButton
      kind="ghost"
      size="sm"
      align="left"
      label={`Leave open day ${when(item.startsAt, item.endsAt, now)}`}
      onClick={onLeave}
    >
      <Logout />
    </IconButton>
  );
}

/** Confirms leaving an open-day timeslot; the dashboard reloads afterwards. */
export function LeaveOpenDayModal({
  item,
  now,
  onClose,
}: {
  item: ComingUpItem | null;
  now: number;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const leave = useMutation({
    mutationFn: (target: ComingUpItem) => leaveOpenDay(target.openDayId!, { timeslotId: target.timeslotId! }),
    onSuccess: async () => {
      onClose();
      await client.invalidateQueries({ queryKey: dashboardKeys.personal() });
    },
  });
  return (
    <Modal
      open={item !== null}
      danger
      size="xs"
      modalHeading="Leave this open day?"
      primaryButtonText={leave.isPending ? 'Leaving…' : 'Leave open day'}
      secondaryButtonText="Stay signed up"
      primaryButtonDisabled={leave.isPending}
      onRequestClose={() => {
        leave.reset();
        onClose();
      }}
      onRequestSubmit={() => {
        if (item?.openDayId && item.timeslotId) leave.mutate(item);
      }}
    >
      {item && (
        <p>
          {item.title}: {when(item.startsAt, item.endsAt, now)}. The Leitung sees the open place on the staffing page.
        </p>
      )}
      {leave.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Could not leave the open day"
          subtitle="Try again in a moment."
        />
      )}
    </Modal>
  );
}
