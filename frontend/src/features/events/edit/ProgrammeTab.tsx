import { Add } from '@carbon/icons-react';
import {
  Button,
  OverflowMenu,
  OverflowMenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Tile,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  deleteEventSession,
  deleteEventShift,
  duplicateEventShift,
  updateEventSession,
  updateEventShift,
} from '../../../api/generated/events/events';
import type { Event, EventSession, EventShift, EventShiftStatus } from '../../../api/generated/models';
import { dateInAppTimeZone } from '../../../app/dateTime';
import { ErrorState, EmptyState, InlineLoadingState } from '../../../app/PageState';
import { FillMeter } from '../components/FillMeter';
import { SectionHeading, TabToolbar } from '../components/Layout';
import { ShiftStatusTag, VisibilityTag } from '../components/StatusTags';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { SessionDialog } from '../dialogs/SessionDialog';
import { ShiftDialog } from '../dialogs/ShiftDialog';
import { eventMutationMessage } from '../errors';
import { fmtDay, fmtRange, plural } from '../format';
import { closedNotice, isClosed, programme } from '../logic';
import { eventSessionsQueryOptions, eventShiftsQueryOptions, invalidateEvents } from '../queries';
import { sessionBody, shiftBody } from '../requestBodies';
import { ScrollRegion } from '../components/ScrollRegion';

type Dialog =
  | { kind: 'session'; session?: EventSession }
  | { kind: 'shift'; shift?: EventShift; session?: EventSession }
  | { kind: 'cancel-session' | 'delete-session'; session: EventSession }
  | { kind: 'cancel-shift' | 'delete-shift'; shift: EventShift };

const NEXT_STATUS: Record<EventShiftStatus, { label: string; to: EventShiftStatus }[]> = {
  draft: [{ label: 'Open for signup', to: 'open' }],
  open: [
    { label: 'Close signup', to: 'closed' },
    { label: 'Back to draft', to: 'draft' },
  ],
  closed: [{ label: 'Reopen signup', to: 'open' }],
  cancelled: [{ label: 'Restore as draft', to: 'draft' }],
};

/** Sessions and their helper shifts on one timeline, grouped by day. */
export function ProgrammeTab({
  event,
  canSessions,
  canShifts,
}: {
  event: Event;
  canSessions: boolean;
  canShifts: boolean;
}) {
  const client = useQueryClient();
  const sessionsQuery = useQuery(eventSessionsQueryOptions(event.id));
  const shiftsQuery = useQuery(eventShiftsQueryOptions(event.id));
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const closed = isClosed(event.status);
  const sessions = sessionsQuery.data?.items ?? [];
  const shifts = shiftsQuery.data?.items ?? [];
  const days = programme(sessions, shifts);
  const close = () => setDialog(null);
  const refresh = () => invalidateEvents(client);
  const run = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: async () => {
      await refresh();
      close();
    },
  });
  const failure = run.isError ? eventMutationMessage(run.error) : undefined;
  const setShiftStatus = (shift: EventShift, status: EventShiftStatus) =>
    run.mutate(() => updateEventShift(event.id, shift.id, shiftBody(shift, { status })));
  const toggleSession = (session: EventSession) =>
    run.mutate(() =>
      updateEventSession(
        event.id,
        session.id,
        sessionBody(session, { status: session.status === 'cancelled' ? 'scheduled' : 'cancelled' }),
      ),
    );

  const shiftTable = (rows: EventShift[]) => (
    <ScrollRegion label="Helper shifts">
      <Table size="md" aria-label="Helper shifts" className="ev-table ev-table--shifts">
        <TableHead>
          <TableRow>
            <TableHeader>Time</TableHeader>
            <TableHeader>Shift</TableHeader>
            <TableHeader>Positions</TableHeader>
            <TableHeader>Signup</TableHeader>
            <TableHeader>Visibility</TableHeader>
            <TableHeader className="ev-col-actions">
              <span className="cds--visually-hidden">Actions</span>
            </TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((shift) => (
            <TableRow key={shift.id} className={shift.status === 'cancelled' ? 'ev-row--cancelled' : undefined}>
              <TableCell className="ev-col-time">{fmtRange(shift.startsAt, shift.endsAt)}</TableCell>
              <TableCell>
                <span className="ev-row__name">{shift.name}</span>
              </TableCell>
              <TableCell>
                {shift.requirements.length === 0 ? (
                  <span className="ev-secondary">No positions yet</span>
                ) : (
                  <div className="ev-positions-cell">
                    {shift.requirements.map((position) => (
                      <FillMeter
                        key={position.id}
                        name={position.name}
                        filled={position.filledCount}
                        required={position.requiredCount}
                      />
                    ))}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <ShiftStatusTag status={shift.status} />
              </TableCell>
              <TableCell>
                <VisibilityTag isPublic={shift.isPublic} />
              </TableCell>
              <TableCell className="ev-col-actions">
                {canShifts && !closed && (
                  <OverflowMenu flipped size="sm" iconDescription={`Actions for shift ${shift.name}`}>
                    <OverflowMenuItem itemText="Edit" onClick={() => setDialog({ kind: 'shift', shift })} />
                    <OverflowMenuItem
                      itemText="Duplicate"
                      onClick={() => run.mutate(() => duplicateEventShift(event.id, shift.id))}
                    />
                    {NEXT_STATUS[shift.status].map((next) => (
                      <OverflowMenuItem
                        key={next.to}
                        itemText={next.label}
                        onClick={() => setShiftStatus(shift, next.to)}
                      />
                    ))}
                    {shift.status !== 'cancelled' && (
                      <OverflowMenuItem
                        itemText="Cancel shift"
                        onClick={() => setDialog({ kind: 'cancel-shift', shift })}
                      />
                    )}
                    <OverflowMenuItem
                      itemText="Delete"
                      isDelete
                      hasDivider
                      onClick={() => setDialog({ kind: 'delete-shift', shift })}
                    />
                  </OverflowMenu>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollRegion>
  );

  const sessionName = (session: EventSession) => session.name || 'Session';
  return (
    <div className="ev-stack ev-tab">
      {closed && <p className="ev-secondary">{closedNotice(event.status)}</p>}
      <TabToolbar
        left={
          <span className="ev-secondary">
            {plural(days.length, 'day')} · {plural(sessions.length, 'session')} · {plural(shifts.length, 'shift')}
          </span>
        }
        right={
          !closed && (
            <>
              {canSessions && (
                <Button kind="tertiary" size="md" renderIcon={Add} onClick={() => setDialog({ kind: 'session' })}>
                  Add session
                </Button>
              )}
              {canShifts && (
                <Button kind="tertiary" size="md" renderIcon={Add} onClick={() => setDialog({ kind: 'shift' })}>
                  Add shift
                </Button>
              )}
            </>
          )
        }
      />
      {(sessionsQuery.isPending || shiftsQuery.isPending) && <InlineLoadingState label="Loading programme" />}
      {(sessionsQuery.isError || shiftsQuery.isError) && (
        <ErrorState
          title="Unable to load the programme"
          message="Check the connection and try again."
          onRetry={() => {
            void sessionsQuery.refetch();
            void shiftsQuery.refetch();
          }}
        />
      )}
      {failure && !dialog && <p className="ev-error">{failure}</p>}
      {sessionsQuery.isSuccess && shiftsQuery.isSuccess && days.length === 0 && (
        <EmptyState
          title="The programme is empty"
          description="Add a session for what visitors attend and helper shifts for the work behind it."
        />
      )}
      {days.map((day) => (
        <section key={day.key} className="ev-day" aria-label={fmtDay(day.date)}>
          <SectionHeading
            title={fmtDay(day.date)}
            summary={`${plural(day.sessions.length, 'session')} · ${plural(
              day.sessions.reduce((n, s) => n + s.shifts.length, day.loose.length),
              'shift',
            )}`}
          />
          {day.sessions.map(({ session, shifts: sessionShifts }) => (
            <Tile
              key={session.id}
              className={`ev-session${session.status === 'cancelled' ? ' ev-session--cancelled' : ''}`}
            >
              <div className="ev-session__head">
                <span className="ev-session__time">{fmtRange(session.startsAt, session.endsAt)}</span>
                <div className="ev-session__title">
                  <strong>{sessionName(session)}</strong>
                  <span className="ev-secondary">{session.location || 'No location'}</span>
                </div>
                <div className="ev-inline ev-session__tags">
                  {session.status === 'cancelled' && (
                    <Tag size="sm" type="red">
                      Cancelled
                    </Tag>
                  )}
                  <VisibilityTag isPublic={session.isPublic} />
                  {canSessions && !closed && (
                    <OverflowMenu flipped size="sm" iconDescription={`Actions for session ${sessionName(session)}`}>
                      <OverflowMenuItem itemText="Edit" onClick={() => setDialog({ kind: 'session', session })} />
                      <OverflowMenuItem
                        itemText={session.status === 'cancelled' ? 'Restore session' : 'Cancel session'}
                        onClick={() =>
                          session.status === 'cancelled'
                            ? toggleSession(session)
                            : setDialog({ kind: 'cancel-session', session })
                        }
                      />
                      <OverflowMenuItem
                        itemText="Delete"
                        isDelete
                        hasDivider
                        onClick={() => setDialog({ kind: 'delete-session', session })}
                      />
                    </OverflowMenu>
                  )}
                </div>
              </div>
              {sessionShifts.length > 0 ? (
                shiftTable(sessionShifts)
              ) : (
                <p className="ev-secondary">No helper shifts for this session.</p>
              )}
              {canShifts && !closed && (
                <div>
                  <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setDialog({ kind: 'shift', session })}>
                    Add shift to this session
                  </Button>
                </div>
              )}
            </Tile>
          ))}
          {day.loose.length > 0 && (
            <Tile className="ev-session">
              <h3 className="ev-session__loose-title">Helper shifts (no session)</h3>
              {shiftTable(day.loose)}
            </Tile>
          )}
        </section>
      ))}

      {dialog?.kind === 'session' && (
        <SessionDialog
          event={event}
          session={dialog.session}
          lastDate={sessions.length ? dateInAppTimeZone(sessions[sessions.length - 1].startsAt) : undefined}
          onClose={close}
        />
      )}
      {dialog?.kind === 'shift' && (
        <ShiftDialog event={event} shift={dialog.shift} session={dialog.session} sessions={sessions} onClose={close} />
      )}
      {dialog?.kind === 'cancel-session' && (
        <ConfirmDialog
          heading="Cancel session"
          label={event.name}
          confirmText="Cancel session"
          danger
          pending={run.isPending}
          error={failure}
          onClose={close}
          onConfirm={() => toggleSession(dialog.session)}
        >
          <p>
            &ldquo;{sessionName(dialog.session)}&rdquo; stays in the programme as cancelled. Helper signup for its
            linked shifts closes. You can restore it later.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'delete-session' && (
        <ConfirmDialog
          heading="Delete session"
          label={event.name}
          confirmText="Delete session"
          danger
          pending={run.isPending}
          error={failure}
          onClose={close}
          onConfirm={() =>
            run.mutate(() =>
              deleteEventSession(event.id, dialog.session.id, { expectedVersion: dialog.session.version }),
            )
          }
        >
          <p>
            &ldquo;{sessionName(dialog.session)}&rdquo; is removed. Its helper shifts are kept and move to &ldquo;Helper
            shifts (no session)&rdquo;.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'cancel-shift' && (
        <ConfirmDialog
          heading="Cancel shift"
          label={event.name}
          confirmText="Cancel shift"
          danger
          pending={run.isPending}
          error={failure}
          onClose={close}
          onConfirm={() => setShiftStatus(dialog.shift, 'cancelled')}
        >
          <p>
            &ldquo;{dialog.shift.name}&rdquo; no longer counts towards staffing and closes for signup. Existing
            assignments are kept for the history.
          </p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'delete-shift' && (
        <ConfirmDialog
          heading="Delete shift"
          label={event.name}
          confirmText="Delete shift"
          danger
          pending={run.isPending}
          error={failure}
          onClose={close}
          onConfirm={() =>
            run.mutate(() => deleteEventShift(event.id, dialog.shift.id, { expectedVersion: dialog.shift.version }))
          }
        >
          <p>
            &ldquo;{dialog.shift.name}&rdquo; and its positions are removed. Only shifts that never had an assignment
            can be deleted; cancel the shift otherwise.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}
