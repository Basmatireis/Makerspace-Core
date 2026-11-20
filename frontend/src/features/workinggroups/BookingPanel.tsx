import { useRef, useState } from 'react';
import { Button, InlineNotification } from '@carbon/react';
import type { WorkingGroupBooking } from '../../api/generated/models';
import {
  deleteWorkingGroupBooking,
  redactWorkingGroupBooking,
} from '../../api/generated/working-groups/working-groups';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { DetailPanel, DetailPanelHead } from '../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../app/components/Facts';
import { formatCents, toCents } from '../orders/money';
import { formatDateOnly } from './taskModel';
import { taskErrorText, useWgMutation } from './useWgMutation';

/** The panel of a booking made directly against a group's budget; finance managers can delete it or remove its text. */
export function BookingPanel({
  booking,
  finance,
  onGone,
}: {
  booking: WorkingGroupBooking;
  finance: boolean;
  onGone: () => void;
}) {
  const [confirm, setConfirm] = useState<'delete' | 'redact' | null>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const redactButton = useRef<HTMLButtonElement>(null);
  const remove = useWgMutation(() => deleteWorkingGroupBooking(booking.id));
  const redact = useWgMutation(() => redactWorkingGroupBooking(booking.id));
  const active = confirm === 'delete' ? remove : redact;
  return (
    <DetailPanel>
      <DetailPanelHead
        title={booking.text}
        meta={`Booked directly · ${booking.groupName}`}
        secondary={formatDateOnly(booking.bookedOn)}
      />
      <p className="wg-panel-body">Booked against the budget without a purchase.</p>
      {finance && (
        <div className="wg-panel-actions">
          <Button
            ref={deleteButton}
            kind="danger--ghost"
            size="md"
            onClick={() => {
              remove.reset();
              setConfirm('delete');
            }}
          >
            Delete
          </Button>
          <Button
            ref={redactButton}
            kind="tertiary"
            size="md"
            onClick={() => {
              redact.reset();
              setConfirm('redact');
            }}
          >
            Remove the text
          </Button>
        </div>
      )}
      <FactsGrid columns={2}>
        <Fact label="Amount">{formatCents(toCents(booking.amount))}</Fact>
        <Fact label="Group">{booking.groupName}</Fact>
      </FactsGrid>
      {active.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not saved"
          subtitle={taskErrorText(active.error, 'Try again.')}
        />
      )}
      <DestructiveActionDialog
        open={confirm !== null}
        title={confirm === 'delete' ? 'Delete booking' : 'Remove the text'}
        fate="permanent"
        confirmLabel={confirm === 'delete' ? 'Delete booking' : 'Remove the text'}
        pending={active.isPending}
        error={active.isError ? taskErrorText(active.error, 'It could not be saved.') : undefined}
        launcherButtonRef={confirm === 'delete' ? deleteButton : redactButton}
        onClose={() => setConfirm(null)}
        onConfirm={() =>
          active.mutate(undefined, {
            onSuccess: () => {
              setConfirm(null);
              if (confirm === 'delete') onGone();
            },
          })
        }
      >
        <p>{booking.text}</p>
      </DestructiveActionDialog>
    </DetailPanel>
  );
}
