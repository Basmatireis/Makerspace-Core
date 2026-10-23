import { Button, ContainedList, ContainedListItem, Stack, Tile } from '@carbon/react';
import { Checkmark, WarningFilled } from '@carbon/icons-react';
import type { AttendanceHold } from '../../../api/generated/models';
import { formatTime } from '../../../app/dateTime';
import { labRulesProblem } from '../presentation';

export function HeldCheckIns({
  holds,
  canCancel,
  canConfirm,
  busy,
  onConfirm,
  onCancel,
}: {
  holds: AttendanceHold[];
  canCancel: boolean;
  canConfirm: boolean;
  busy: boolean;
  onConfirm: (hold: AttendanceHold) => void;
  onCancel: (hold: AttendanceHold) => void;
}) {
  return (
    <Tile className="attendance-hold">
      <Stack gap={5}>
        <div className="attendance-hold__header">
          <WarningFilled size={24} aria-hidden="true" />
          <div>
            <h2>Waiting for Lab Rules confirmation</h2>
            <p>
              These people tried to check in at the tablet. They are not admitted until you have seen their signed Lab
              Rules and confirmed it here.
            </p>
          </div>
        </div>
        <ContainedList kind="on-page" size="xl" label="Held check-ins">
          {holds.map((hold) => (
            <ContainedListItem
              key={hold.id}
              action={
                <div className="attendance-hold__actions">
                  {canCancel && (
                    <Button kind="ghost" size="md" disabled={busy} onClick={() => onCancel(hold)}>
                      Cancel check-in
                    </Button>
                  )}
                  {canConfirm && hold.laborordnungRequestId && (
                    <Button size="md" renderIcon={Checkmark} onClick={() => onConfirm(hold)}>
                      Confirm Lab Rules
                    </Button>
                  )}
                </div>
              }
            >
              <div className="attendance-hold__person">
                <strong>{hold.displayName}</strong>
                <span>
                  {labRulesProblem(hold)} · at the entrance since {formatTime(hold.requestedAt)}
                </span>
              </div>
            </ContainedListItem>
          ))}
        </ContainedList>
      </Stack>
    </Tile>
  );
}
