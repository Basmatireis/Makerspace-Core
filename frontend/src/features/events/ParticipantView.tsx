import './styles.scss';
import { Edit, UserFollow, UserMultiple } from '@carbon/icons-react';
import {
  Button,
  InlineNotification,
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
import { Link } from 'react-router-dom';
import { joinEventPosition, leaveEventPosition } from '../../api/generated/events/events';
import type {
  Event,
  EventMyAssignment,
  EventParticipationPosition,
  EventParticipationShift,
} from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { eventAccess } from './access';
import { SectionHeading, SummaryStrip } from './components/Layout';
import { EventStatusTag } from './components/StatusTags';
import { AssignDialog } from './dialogs/AssignDialog';
import { eventMutationMessage } from './errors';
import { fmtDay, fmtRange, rangeLabel } from './format';
import { isClosed, joinReasonLabel, programme } from './logic';
import { eventParticipationQueryOptions, invalidateEvents } from './queries';
import { ScrollRegion } from './components/ScrollRegion';

/** What a helper sees: own shifts with Leave, then the programme by day with Join. Organizers see it before the edit mode. */
export function ParticipantView({ event }: { event: Event }) {
  const access = eventAccess(useCurrentUser());
  const client = useQueryClient();
  const query = useQuery(eventParticipationQueryOptions(event.id));
  const [leaving, setLeaving] = useState<EventMyAssignment | null>(null);
  const [assigning, setAssigning] = useState<{ shiftId: string; requirementId: string } | null>(null);
  const join = useMutation({
    mutationFn: ({ shiftId, positionId }: { shiftId: string; positionId: string }) =>
      joinEventPosition(event.id, shiftId, positionId),
    onSuccess: () => invalidateEvents(client),
  });
  const leave = useMutation({
    mutationFn: (assignment: EventMyAssignment) =>
      leaveEventPosition(event.id, assignment.assignmentId, { expectedVersion: assignment.version }),
    onSuccess: async () => {
      setLeaving(null);
      await invalidateEvents(client);
    },
  });
  const closed = isClosed(event.status);
  const canAssign = access.assign && !closed;
  const data = query.data;
  const showNames = data?.canSeeNames ?? false;

  const edit = access.canEdit ? (
    <Button renderIcon={Edit} as={Link} to={`/events/${event.id}?mode=edit`}>
      Edit event
    </Button>
  ) : access.assign ? (
    <Button renderIcon={UserMultiple} as={Link} to={`/events/${event.id}?mode=edit&tab=helpers`}>
      Manage helpers
    </Button>
  ) : undefined;

  const positionRow = (shift: EventParticipationShift, position: EventParticipationPosition) => {
    const reason = joinReasonLabel(position);
    const mine = Boolean(position.myAssignmentId);
    const open = position.filledCount < position.requiredCount && shift.status !== 'cancelled';
    const names = (position.helpers ?? []).map((helper) => (helper.isMe ? 'You' : (helper.displayName ?? 'Helper')));
    return (
      <TableRow key={position.id}>
        <TableCell>
          {position.name}
          {showNames && names.length > 0 && <span className="ev-helper-names ev-secondary">{names.join(', ')}</span>}
        </TableCell>
        <TableCell>
          {position.filledCount} of {position.requiredCount}
        </TableCell>
        <TableCell>
          <div className="ev-actions-cell">
            {mine && (
              <Tag size="sm" type="green">
                You are signed up
              </Tag>
            )}
            {!mine && position.joinable && (
              <Button
                size="sm"
                disabled={join.isPending}
                onClick={() => join.mutate({ shiftId: shift.id, positionId: position.id })}
              >
                Join
              </Button>
            )}
            {!mine && !position.joinable && reason && (
              <Tag
                size="sm"
                type={position.reason === 'roles_only' ? 'purple' : position.reason === 'full' ? 'gray' : 'blue'}
              >
                {reason}
              </Tag>
            )}
            {!mine && !position.joinable && !reason && open && <span className="ev-secondary">Open place</span>}
            {canAssign && open && (
              <Button
                kind="ghost"
                size="sm"
                renderIcon={UserFollow}
                onClick={() => setAssigning({ shiftId: shift.id, requirementId: position.id })}
              >
                Assign
              </Button>
            )}
          </div>
        </TableCell>
      </TableRow>
    );
  };

  const shiftBlock = (shift: EventParticipationShift) => (
    <Tile key={shift.id} className="ev-pshift">
      <SectionHeading
        level={3}
        title={shift.name}
        summary={`${fmtDay(shift.startsAt)}, ${fmtRange(shift.startsAt, shift.endsAt)}`}
      />
      {shift.description && <p className="ev-secondary">{shift.description}</p>}
      {shift.positions.length === 0 ? (
        <p className="ev-secondary">No positions yet.</p>
      ) : (
        <Table size="md" aria-label={`Positions of ${shift.name}`} className="ev-table ev-table--positions">
          <TableHead>
            <TableRow>
              <TableHeader>Position</TableHeader>
              <TableHeader>Filled</TableHeader>
              <TableHeader>Your signup</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>{shift.positions.map((position) => positionRow(shift, position))}</TableBody>
        </Table>
      )}
    </Tile>
  );

  const days = data ? programme(data.sessions, data.shifts) : [];
  const empty = days.every((day) => day.sessions.length === 0 && day.loose.length === 0);
  const mine = data?.myAssignments ?? [];

  return (
    <PageShell
      title={event.name}
      width="wide"
      className="event-detail-page"
      breadcrumbs={[{ label: 'Events', to: '/events' }]}
      titleAdornment={<EventStatusTag status={event.status} />}
      actions={edit}
    >
      <div className="ev-stack">
        <SummaryStrip
          label="Event summary"
          items={[
            { label: 'Date', value: rangeLabel(event) },
            { label: 'Location', value: event.location || <span className="ev-secondary">Not set</span> },
            { label: 'Your shifts', value: mine.length },
          ]}
        />
        {event.status === 'draft' && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="This event is a draft"
            subtitle="Helpers cannot see it yet. This is what they will see once it is confirmed."
          />
        )}
        {closed && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title={`This event is ${event.status}`}
            subtitle="Signup is closed. This page is read-only."
          />
        )}
        {(join.isError || leave.isError) && (
          <InlineNotification
            kind="error"
            lowContrast
            title={join.isError ? 'Could not join' : 'Could not leave'}
            subtitle={eventMutationMessage(join.error ?? leave.error)}
            onClose={() => {
              join.reset();
              leave.reset();
              return false;
            }}
          />
        )}
        {event.internalDescription && <p className="ev-pre">{event.internalDescription}</p>}
        {query.isPending && <InlineLoadingState label="Loading programme" />}
        {query.isError && (
          <ErrorState
            title="Unable to load the programme"
            message="Check the connection and try again."
            onRetry={() => void query.refetch()}
          />
        )}
        {mine.length > 0 && (
          <section className="ev-day" aria-label="Your shifts">
            <SectionHeading title="You are signed up" summary={String(mine.length)} />
            <ScrollRegion label="Your shifts">
              <Table size="md" aria-label="Your shifts" className="ev-table">
                <TableHead>
                  <TableRow>
                    <TableHeader>Shift</TableHeader>
                    <TableHeader>Position</TableHeader>
                    <TableHeader>Time</TableHeader>
                    <TableHeader className="ev-col-actions">
                      <span className="cds--visually-hidden">Leave</span>
                    </TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {mine.map((assignment) => (
                    <TableRow key={assignment.assignmentId}>
                      <TableCell>{assignment.shiftName}</TableCell>
                      <TableCell>{assignment.requirementName}</TableCell>
                      <TableCell>
                        {fmtDay(assignment.startsAt)}, {fmtRange(assignment.startsAt, assignment.endsAt)}
                      </TableCell>
                      <TableCell className="ev-col-actions">
                        {assignment.canLeave ? (
                          <Button kind="tertiary" size="sm" onClick={() => setLeaving(assignment)}>
                            Leave
                          </Button>
                        ) : (
                          <span className="ev-secondary">
                            {assignment.leaveBlockedReason === 'shift_ended' ? 'Shift ended' : 'Closed'}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollRegion>
          </section>
        )}
        {data && empty && <p className="ev-secondary">The programme has not been published yet.</p>}
        {days.map((day) => (
          <section key={day.key} className="ev-day" aria-label={fmtDay(day.date)}>
            <SectionHeading title={fmtDay(day.date)} />
            {day.sessions.map(({ session, shifts }) => (
              <div key={session.id} className="ev-session">
                <div className="ev-pshift__head">
                  <strong className={session.status === 'cancelled' ? 'ev-struck' : undefined}>
                    {session.name || 'Session'}
                  </strong>
                  <span className="ev-secondary">
                    {fmtRange(session.startsAt, session.endsAt)}
                    {session.location && ` · ${session.location}`}
                  </span>
                  {session.status === 'cancelled' && (
                    <Tag size="sm" type="red">
                      Cancelled
                    </Tag>
                  )}
                </div>
                {session.description && <p className="ev-secondary">{session.description}</p>}
                {shifts.map(shiftBlock)}
              </div>
            ))}
            {day.loose.length > 0 && (
              <div className="ev-session">
                {day.sessions.length > 0 && (
                  <strong className="ev-session__loose-title">Shifts without a session</strong>
                )}
                {day.loose.map(shiftBlock)}
              </div>
            )}
          </section>
        ))}
      </div>
      <DestructiveActionDialog
        open={Boolean(leaving)}
        title="Leave shift?"
        confirmLabel="Leave shift"
        pending={leave.isPending}
        error={leave.isError ? eventMutationMessage(leave.error) : undefined}
        onClose={() => {
          leave.reset();
          setLeaving(null);
        }}
        onConfirm={() => leaving && leave.mutate(leaving)}
      >
        <p>
          You give up your place in {leaving?.shiftName} · {leaving?.requirementName}. It becomes open for other
          members; you can join again while places are free.
        </p>
      </DestructiveActionDialog>
      {assigning && (
        <AssignDialog
          eventId={event.id}
          shiftId={assigning.shiftId}
          requirementId={assigning.requirementId}
          onClose={() => setAssigning(null)}
        />
      )}
    </PageShell>
  );
}
