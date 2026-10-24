import { Button, ContainedList, ContainedListItem, Stack, Tile } from '@carbon/react';
import { Checkmark, InformationFilled, WarningFilled } from '@carbon/icons-react';
import type { AttendanceHold, LaborordnungRequest } from '../../../api/generated/models';
import { formatDateTime, formatTime } from '../../../app/dateTime';
import { labRulesProblem } from '../presentation';

/** Prominent notice for everything that waits on a Lab Rules confirmation: people at the entrance first. */
export function LabRulesNotice({
  holds,
  requests,
  canCancel,
  canConfirm,
  busy,
  onConfirmHold,
  onCancelHold,
  onConfirmRequest,
}: {
  holds: AttendanceHold[];
  requests: LaborordnungRequest[];
  canCancel: boolean;
  canConfirm: boolean;
  busy: boolean;
  onConfirmHold: (hold: AttendanceHold) => void;
  onCancelHold: (hold: AttendanceHold) => void;
  onConfirmRequest: (request: LaborordnungRequest) => void;
}) {
  const heldPersonIds = new Set(holds.map((hold) => hold.personId));
  const others = requests.filter((request) => request.status === 'pending' && !heldPersonIds.has(request.personId));
  if (holds.length === 0 && others.length === 0) return null;
  const urgent = holds.length > 0;
  const Icon = urgent ? WarningFilled : InformationFilled;

  return (
    <Tile className={urgent ? 'attendance-hold' : 'attendance-hold is-calm'}>
      <Stack gap={5}>
        <div className="attendance-hold__header">
          <Icon size={24} aria-hidden="true" />
          <div>
            <h2>{urgent ? 'Waiting for Lab Rules confirmation' : 'Lab Rules to confirm'}</h2>
            <p>
              {urgent
                ? 'These people tried to check in at the tablet. They are not admitted until you have seen their signed Lab Rules and confirmed it here.'
                : 'These people still need their signed Lab Rules confirmed before they can be admitted.'}
            </p>
          </div>
        </div>
        <ContainedList kind="on-page" size="xl" label="Lab Rules confirmations">
          {holds.map((hold) => (
            <ContainedListItem
              key={hold.id}
              action={
                <div className="attendance-hold__actions">
                  {canCancel && (
                    <Button
                      kind="ghost"
                      size="md"
                      disabled={busy}
                      aria-label={`Cancel check-in for ${hold.displayName}`}
                      onClick={() => onCancelHold(hold)}
                    >
                      Cancel check-in
                    </Button>
                  )}
                  {canConfirm && hold.laborordnungRequestId && (
                    <Button
                      size="md"
                      renderIcon={Checkmark}
                      aria-label={`Confirm Lab Rules for ${hold.displayName}`}
                      onClick={() => onConfirmHold(hold)}
                    >
                      Confirm Lab Rules
                    </Button>
                  )}
                </div>
              }
            >
              <div className="attendance-hold__person">
                <strong>{hold.displayName}</strong>
                <span>
                  {labRulesProblem(hold.previousRevision ?? null, hold.requiredRevision ?? null)} · at the entrance
                  since {formatTime(hold.requestedAt)}
                </span>
              </div>
            </ContainedListItem>
          ))}
          {others.map((request) => (
            <ContainedListItem
              key={request.id}
              action={
                canConfirm ? (
                  <Button
                    kind={urgent ? 'tertiary' : 'primary'}
                    size="md"
                    renderIcon={Checkmark}
                    aria-label={`Confirm Lab Rules for ${request.personName}`}
                    onClick={() => onConfirmRequest(request)}
                  >
                    Confirm Lab Rules
                  </Button>
                ) : undefined
              }
            >
              <div className="attendance-hold__person">
                <strong>{request.personName}</strong>
                <span>
                  Lab Rules revision {request.requiredVersion.humanRevision} · requested{' '}
                  {formatDateTime(request.requestedAt)}
                </span>
              </div>
            </ContainedListItem>
          ))}
        </ContainedList>
      </Stack>
    </Tile>
  );
}
