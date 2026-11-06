import { Button, IconButton, InlineNotification, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { Add, Close, Edit, TrashCan } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import type {
  OpenDay,
  OpenDayAssignment,
  OpenDayPeriod,
  OpenDayStaffRequirement,
  OpenDayTimeslot,
} from '../../../api/generated/models';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../../app/components/Facts';
import { StateTag } from '../components/Places';
import { initialsOf } from '../model/people';
import { dateOf, longDate, plural, relativeDay, timeRange, weekdayName } from '../model/dates';
import type { ChangeKind, SeriesView } from '../model/derive';
import {
  free,
  joinablePlaces,
  mySlots,
  myRequirement,
  slotEnded,
  slotState,
  stateTag,
  supporters,
  type StateContext,
} from '../model/state';

export type DayActions = {
  onClose: () => void;
  onJoin: (day: OpenDay, slot: OpenDayTimeslot, requirement: OpenDayStaffRequirement) => void;
  onLeave: (day: OpenDay, slot: OpenDayTimeslot) => void;
  onRemove: (day: OpenDay, slot: OpenDayTimeslot, assignment: OpenDayAssignment) => void;
  onAssign: (slot: OpenDayTimeslot, requirement: OpenDayStaffRequirement) => void;
  onEdit: () => void;
  onEditSeries: (seriesId: string) => void;
  onRejoin: (day: OpenDay) => void;
  onDuplicate: (day: OpenDay) => void;
  onCancel: (day: OpenDay) => void;
  onCancelRest: (day: OpenDay, series: SeriesView) => void;
};

const kindName = (kind: string, count = 2) =>
  kind === 'supervisor' ? (count === 1 ? 'Supervisor' : 'Supervisors') : count === 1 ? 'Trainee' : 'Trainees';

function RequirementSection({
  day,
  slot,
  requirement,
  ctx,
  actions,
  roleNames,
  busy,
  locked,
}: {
  day: OpenDay;
  slot: OpenDayTimeslot;
  requirement: OpenDayStaffRequirement;
  ctx: StateContext;
  actions: DayActions;
  roleNames: ReadonlyMap<string, string>;
  busy: boolean;
  locked: boolean;
}) {
  const { viewer } = ctx;
  const open = day.status !== 'cancelled' && !slotEnded(slot, ctx.now);
  const roles = (requirement.eligibleRoleIds ?? []).map((id) => roleNames.get(id) ?? 'a role');
  const canAssign = (viewer.canAssign || viewer.canManage) && open && !locked;
  const joinable = requirement.canJoin && free(requirement) > 0 && !locked;
  const people = requirement.assignments;
  return (
    <section className="od-req" data-guide="open-days-positions">
      <h3>
        {kindName(requirement.kind)}{' '}
        <span className="od-req__count">
          {requirement.assignedCount} of {requirement.requiredCount}
        </span>
        {requirement.kind === 'trainee' && free(requirement) > 0 && viewer.canManage && (
          <small>never counts as short</small>
        )}
      </h3>
      {roles.length > 0 ? (
        <p className="od-hint">
          Only {kindName(requirement.kind).toLowerCase()} with the role {roles.join(' or ')}.
        </p>
      ) : !requirement.eligible && viewer.canSignUp ? (
        <p className="od-hint">Only for {kindName(requirement.kind).toLowerCase()}.</p>
      ) : null}
      {people ? (
        <ul>
          {people.map((assignment) => {
            const mine = assignment.isCurrentUser;
            return (
              <li key={assignment.id} className="od-person">
                <i className={`od-av${mine ? ' is-me' : ''}`}>{initialsOf(assignment.displayName)}</i>
                <span>
                  <b>
                    {assignment.displayName}
                    {mine ? ' (you)' : ''}
                  </b>
                </span>
                {mine && open && viewer.canSignUp && !locked ? (
                  <Button
                    kind="danger--ghost"
                    size="sm"
                    disabled={busy}
                    data-guide="open-days-leave"
                    onClick={() => actions.onLeave(day, slot)}
                  >
                    Leave
                  </Button>
                ) : canAssign ? (
                  <IconButton
                    kind="ghost"
                    size="md"
                    label={`Remove ${assignment.displayName}`}
                    disabled={busy}
                    onClick={() => actions.onRemove(day, slot, assignment)}
                  >
                    <Close />
                  </IconButton>
                ) : null}
              </li>
            );
          })}
          {Array.from({ length: free(requirement) }, (_, index) => (
            <li key={`free-${index}`} className="od-person od-person--free">
              <i className={`od-av od-av--free${joinable ? ' is-for-me' : ''}`} />
              <span>
                <b className={requirement.kind === 'supervisor' && open ? 'od-needed' : undefined}>Free place</b>
              </span>
              {index === 0 && canAssign && (
                <Button
                  kind="ghost"
                  size="sm"
                  data-guide="open-days-assign"
                  onClick={() => actions.onAssign(slot, requirement)}
                >
                  Assign
                </Button>
              )}
              {index === 0 && joinable && (
                <Button
                  kind="primary"
                  size="sm"
                  disabled={busy}
                  data-guide="open-days-join"
                  onClick={() => actions.onJoin(day, slot, requirement)}
                >
                  Join
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="od-hint">{plural(requirement.assignedCount, 'place')} taken.</p>
      )}
    </section>
  );
}

/** The detail panel of one open day: who is there, sign up or leave, and for the Leitung the edit tools. */
export function DayPanel({
  day,
  period,
  ctx,
  change,
  series,
  roleNames,
  busy,
  actions,
}: {
  day: OpenDay;
  period: OpenDayPeriod;
  ctx: StateContext;
  change: ChangeKind | undefined;
  series: SeriesView | undefined;
  roleNames: ReadonlyMap<string, string>;
  busy: boolean;
  actions: DayActions;
}) {
  const { viewer, now } = ctx;
  const date = dateOf(day.startsAt);
  const multi = day.timeslots.length > 1;
  const ended = new Date(day.endsAt) <= now;
  const cancelled = day.status === 'cancelled';
  // Days a series change or a new series produced cannot be edited on their own before the changes are saved.
  const locked = (change === 'series' || change === 'new') && !day.id.startsWith('new-');
  const unsavedSingle = day.id.startsWith('new-');
  const mine = mySlots(day).filter((slot) => !slotEnded(slot, now));
  const comp = supporters(day);
  const editable = viewer.canManage && !cancelled && !ended && !locked;
  const joinSlot = !multi && !locked ? day.timeslots[0] : undefined;
  const joinPlace = joinSlot && !cancelled && !ended ? joinablePlaces(joinSlot)[0] : undefined;
  const sum = (kind: 'supervisor' | 'trainee') => {
    const items = day.timeslots.map((slot) => slot.requirements.find((item) => item.kind === kind));
    return `${items.reduce((n, item) => n + (item?.assignedCount ?? 0), 0)} of ${items.reduce((n, item) => n + (item?.requiredCount ?? 0), 0)}`;
  };
  const seriesName = series ? `Every ${weekdayName(series.weekday)}` : undefined;
  const relative = relativeDay(date, dateOf(now));
  const showStaffing = viewer.canSignUp || viewer.canSeePeople || viewer.canManage;
  return (
    <DetailPanel className="od-detail">
      <DetailPanelHead
        title={longDate(date)}
        meta={`${timeRange(day.startsAt, day.endsAt)}${multi ? ` · ${plural(day.timeslots.length, 'timeslot')}` : ''}${relative ? ` · ${relative}` : ''}`}
        secondary={period.name}
        helper={
          <span className="od-head-tags">
            <StateTag info={stateTag(day, null, ctx)} />
            {change && change !== 'cancelled' && <span className="od-unsaved">Unsaved</span>}
          </span>
        }
        actions={
          <>
            {editable && (
              <IconButton kind="ghost" size="md" label="Edit this open day" onClick={actions.onEdit}>
                <Edit />
              </IconButton>
            )}
            {editable && !unsavedSingle && (
              <OverflowMenu
                size="md"
                flipped
                aria-label="More actions for this open day"
                iconDescription="More actions"
              >
                {series && <OverflowMenuItem itemText="Edit series" onClick={() => actions.onEditSeries(series.id)} />}
                <OverflowMenuItem itemText="Duplicate to next week" onClick={() => actions.onDuplicate(day)} />
                <OverflowMenuItem
                  itemText={period.status === 'draft' ? 'Delete open day' : 'Cancel open day'}
                  isDelete
                  hasDivider
                  onClick={() => actions.onCancel(day)}
                />
                {series && day.seriesId && (
                  <OverflowMenuItem
                    itemText="Cancel the rest of the series"
                    isDelete
                    onClick={() => actions.onCancelRest(day, series)}
                  />
                )}
              </OverflowMenu>
            )}
            {editable && unsavedSingle && (
              <IconButton
                kind="ghost"
                size="md"
                label="Remove this unsaved open day"
                onClick={() => actions.onCancel(day)}
              >
                <TrashCan />
              </IconButton>
            )}
            <IconButton kind="ghost" size="md" label="Close details" onClick={actions.onClose}>
              <Close />
            </IconButton>
          </>
        }
      />
      {joinPlace && joinSlot && viewer.canSignUp && (
        <div>
          <Button
            kind="primary"
            size="md"
            renderIcon={Add}
            disabled={busy || change === 'edited'}
            onClick={() => actions.onJoin(day, joinSlot, joinPlace)}
          >
            Join as {joinPlace.kind}
          </Button>
        </div>
      )}
      {cancelled && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Cancelled."
          subtitle="Sign-ups are closed; who was assigned stays on record."
        />
      )}
      {locked && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Changed by a series."
          subtitle="Save the schedule before editing this day on its own, or edit the series."
        />
      )}
      {mine.length > 0 && (
        <>
          <InlineNotification
            kind="success"
            lowContrast
            hideCloseButton
            title={`You're in${multi ? ` for ${mine.map((slot) => timeRange(slot.startsAt, slot.endsAt)).join(' and ')}` : ` as ${myRequirement(mine[0])?.kind ?? 'staff'}`}.`}
          />
          <div>
            <Button kind="ghost" size="sm" as={Link} to="/profile#calendar">
              Add to calendar
            </Button>
          </div>
        </>
      )}
      <FactsGrid columns={2}>
        {showStaffing && (
          <Fact label="Supervisors" helper={multi ? 'all timeslots' : undefined}>
            {sum('supervisor')}
          </Fact>
        )}
        {showStaffing && (
          <Fact label="Trainees" helper={multi ? 'all timeslots' : undefined}>
            {sum('trainee')}
          </Fact>
        )}
        <Fact label="Planned support" helper={comp.length ? undefined : 'Appears when supervisors sign up'}>
          {comp.length ? comp.join(', ') : '—'}
        </Fact>
        {viewer.canManage && (
          <Fact
            label="Series"
            helper={
              series && day.seriesId ? (
                <Button kind="ghost" size="sm" onClick={() => actions.onEditSeries(series.id)}>
                  Edit series
                </Button>
              ) : series && day.detachedFromSeriesId && !series.pending ? (
                <Button
                  kind="ghost"
                  size="sm"
                  disabled={locked || change === 'series'}
                  onClick={() => actions.onRejoin(day)}
                >
                  Follow the series again
                </Button>
              ) : undefined
            }
          >
            {day.seriesId ? seriesName : day.detachedFromSeriesId ? 'Edited separately' : 'Single open day'}
          </Fact>
        )}
      </FactsGrid>
      {multi && viewer.canSignUp && !cancelled && !ended && (
        <p className="od-hint">Sign up for one timeslot or several.</p>
      )}
      {showStaffing &&
        day.timeslots.map((slot) => {
          const sections = slot.requirements.map((requirement) => (
            <RequirementSection
              key={requirement.id}
              day={day}
              slot={slot}
              requirement={requirement}
              ctx={ctx}
              actions={actions}
              roleNames={roleNames}
              busy={busy}
              locked={locked || unsavedSingle}
            />
          ));
          return multi ? (
            <section key={slot.id} className={`od-slot state-${slotState(day, slot, ctx)}`}>
              <h3 className="od-slot__t">
                <span>{timeRange(slot.startsAt, slot.endsAt)}</span>
                <StateTag info={stateTag(day, slot, ctx)} />
              </h3>
              {sections}
            </section>
          ) : (
            sections
          );
        })}
      {viewer.canManage && day.internalNote && (
        <DetailPanelSection title="Internal note">
          <p className="od-note-text">{day.internalNote}</p>
        </DetailPanelSection>
      )}
    </DetailPanel>
  );
}
