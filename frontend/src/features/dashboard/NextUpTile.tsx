import { ActionableNotification, Button, InlineNotification, ProgressBar, Tile } from '@carbon/react';
import { ArrowRight, Calendar, CheckmarkFilled, WarningAltFilled } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { joinOpenDay } from '../../api/generated/open-days/open-days';
import type { ComingUpItem, PersonalDashboardStaffing } from '../../api/generated/models';
import { formatTime } from '../../app/dateTime';
import { countdown, dayLabel, leavable, plural, shortDate, when } from './format';
import { LeaveButton, LeaveOpenDayModal } from './LeaveOpenDay';
import { dashboardKeys } from './queries';

/** How many commitments the "After that" list shows below the next one. */
const AFTER_LIMIT = 4;

type Props = {
  /** Upcoming open-day duties and event shifts, chronological. */
  items: ComingUpItem[];
  staffing: PersonalDashboardStaffing;
  now: number;
  canSignUp: boolean;
  canFindOpenDays: boolean;
};

/**
 * The tile's single info box. Supervisors: their next open day is short of supervisors, otherwise the next open day
 * with a free supervisor place. Trainees: the next free trainee place (empty trainee places never matter to
 * supervisors, so the API only reports shortage for supervisor places).
 */
function NextUpHint({ next, staffing, now, canSignUp }: { next: ComingUpItem | undefined } & Omit<Props, 'items'>) {
  const client = useQueryClient();
  const join = useMutation({
    mutationFn: (place: { openDayId: string; requirementId: string }) =>
      joinOpenDay(place.openDayId, { requirementId: place.requirementId }),
    onSuccess: () => client.invalidateQueries({ queryKey: dashboardKeys.personal() }),
  });

  if (join.isError) {
    return (
      <InlineNotification
        kind="error"
        lowContrast
        hideCloseButton
        title="Could not sign you up"
        subtitle="The place may have been taken. Reload to see the current open days."
      />
    );
  }
  if (join.isSuccess) {
    return (
      <InlineNotification
        kind="success"
        lowContrast
        hideCloseButton
        title="Signed up"
        subtitle="The open day is on your list now."
      />
    );
  }

  const shortDay = staffing.nextOpenDay;
  if (
    staffing.kind === 'supervisor' &&
    next?.kind === 'open_day' &&
    shortDay?.shortStaffed &&
    shortDay.openDayId === next.openDayId
  ) {
    const open = shortDay.openSupervisorPlaces;
    return (
      <InlineNotification
        kind="info"
        lowContrast
        hideCloseButton
        title="Short-staffed"
        subtitle={`${open} more ${open === 1 ? 'supervisor is' : 'supervisors are'} needed.`}
      />
    );
  }

  const place = staffing.nextOpenPlace;
  if (!place || !canSignUp) return null;
  const supervisor = staffing.kind === 'supervisor';
  const range = when(place.startsAt, place.endsAt, now);
  return (
    <ActionableNotification
      kind="info"
      lowContrast
      inline
      role="status"
      hideCloseButton
      title={supervisor ? 'Supervisor needed' : 'Trainee place free'}
      subtitle={
        supervisor
          ? `${range}: ${plural(place.freePlaces, 'supervisor place')} still open.`
          : `${range}: join as trainee and learn alongside the supervisors.`
      }
      actionButtonLabel={supervisor ? 'Sign up as supervisor' : 'Sign up as trainee'}
      onActionButtonClick={() => join.mutate({ openDayId: place.openDayId, requirementId: place.requirementId })}
    />
  );
}

/** Where the title of a commitment links to: the open day or the public event page. */
function detailsPath(item: ComingUpItem, canFindOpenDays: boolean): string | null {
  if (item.kind === 'open_day')
    return canFindOpenDays && item.periodId && item.openDayId
      ? `/open-days/${item.periodId}/days/${item.openDayId}`
      : null;
  return item.publicId ? `/events/public/${item.publicId}` : null;
}

function Signed({ item, staffing }: { item: ComingUpItem; staffing: PersonalDashboardStaffing }) {
  return (
    <span className="db-signed">
      <CheckmarkFilled size={16} aria-hidden />
      {item.kind === 'open_day' ? `Signed up as ${staffing.kind}` : 'Signed up for this shift'}
    </span>
  );
}

/** "Open day · 14:00–18:00" for open days, "Maker Faire – Door · 10:00–14:00" for shifts. */
function what(item: ComingUpItem): string {
  return `${item.kind === 'open_day' ? 'Open day' : item.title} · ${formatTime(item.startsAt)}–${formatTime(item.endsAt)}`;
}

/** Progress towards the semester's open-day minimum (supervisors) or towards promotion (trainees). */
function SemesterStatus({ staffing, canFindOpenDays }: Pick<Props, 'staffing' | 'canFindOpenDays'>) {
  const { semester, status } = staffing;
  const trainee = staffing.kind === 'trainee';
  const find = canFindOpenDays && (
    <Button as={Link} to="/open-days" kind="ghost" size="sm" renderIcon={ArrowRight}>
      Find open days
    </Button>
  );
  if (semester === null)
    return (
      <div className="db-semester">
        <div className="db-line">
          <span className="db-tile__meta">No open-day period is scheduled right now.</span>
          {find}
        </div>
      </div>
    );
  // Supervisors: signed-up open days towards the minimum (signing up is enough). Trainees: open days staffed as
  // trainee towards promotion.
  const value = trainee ? staffing.staffedAsTrainee : staffing.staffed + staffing.booked;
  const target = trainee ? staffing.traineeThreshold : staffing.minimum;
  const state =
    status === 'missing'
      ? find
      : status === 'excused'
        ? 'Excused this semester'
        : status === 'no_minimum'
          ? 'No minimum for you'
          : status === 'ready'
            ? 'Ready for supervisor'
            : 'Minimum reached';
  return (
    <div className="db-semester" data-guide="dashboard-semester">
      <div className="db-line">
        <span>
          <strong>
            {value} of {target}
          </strong>{' '}
          {trainee ? 'open days as trainee' : 'open days this semester'}
        </span>
        {typeof state === 'string' ? <span className="db-tile__meta">{state}</span> : state}
      </div>
      <ProgressBar
        label={trainee ? 'Open days as trainee' : 'Open days signed up this semester'}
        hideLabel
        size="small"
        value={Math.min(value, target)}
        max={Math.max(target, 1)}
        status={value >= target ? 'finished' : 'active'}
      />
      <p className="db-tile__meta">
        {semester.name}: {staffing.staffed} staffed, {staffing.booked} booked
        {trainee && status !== 'excused' ? ` · your semester minimum: ${plural(staffing.minimum, 'open day')}` : ''}
      </p>
      {staffing.minimumSource === 'exception' && status !== 'excused' && (
        <p className="db-tile__meta">Your minimum is lower because of an extra role you hold.</p>
      )}
      {status === 'ready' && (
        <p className="db-status db-status--ok">
          <CheckmarkFilled size={16} aria-hidden />
          You can become a supervisor now. The Leitung takes care of it.
        </p>
      )}
      {status === 'fulfilled' && trainee && (
        <p className="db-tile__meta">
          After {plural(target, 'open day')} as trainee the Leitung makes you a supervisor.
        </p>
      )}
      {status === 'missing' && (
        <p className="db-status db-status--warning">
          <WarningAltFilled size={16} aria-hidden />
          Sign up for {plural(staffing.missing, 'open day')} more by {shortDate(semester.signUpBy)} to keep your room
          access.
        </p>
      )}
    </div>
  );
}

/**
 * Next up for people who staff open days: the next commitment, what follows, the hint for a free place and the
 * semester progress at the bottom.
 */
export function NextUpTile(props: Props) {
  const { items, staffing, now, canSignUp, canFindOpenDays } = props;
  const [leaving, setLeaving] = useState<ComingUpItem | null>(null);
  const [next, ...rest] = items;
  const after = rest.slice(0, AFTER_LIMIT);
  const nextPath = next ? detailsPath(next, canFindOpenDays) : null;

  return (
    <Tile className="db-tile" data-guide="dashboard-next-up">
      <span className="db-tile__eyebrow">
        <Calendar size={16} aria-hidden />
        Next up{next ? ` · ${countdown(next.startsAt, next.endsAt, now)}` : ''}
      </span>
      <div className="db-commitments" data-guide="dashboard-coming-up">
        {next ? (
          <div className="db-next">
            <div>
              <p className="db-tile__title">
                {nextPath ? (
                  <Link className="db-next__link" to={nextPath}>
                    {dayLabel(next.startsAt, now)}
                  </Link>
                ) : (
                  dayLabel(next.startsAt, now)
                )}
              </p>
              <p className="db-tile__meta">{what(next)}</p>
              <Signed item={next} staffing={staffing} />
            </div>
            {leavable(next, canSignUp) && <LeaveButton item={next} now={now} onLeave={() => setLeaving(next)} />}
          </div>
        ) : (
          <div>
            <p className="db-tile__title">Nothing booked yet</p>
            <p className="db-tile__meta">
              Open days need supervisors and trainees. Free places in the next{' '}
              {plural(staffing.warningWindowDays, 'day')} are pointed out here.
            </p>
          </div>
        )}
        {after.length > 0 && (
          <div className="db-then">
            <p className="db-then__head">After that</p>
            <ul>
              {after.map((item) => {
                const path = detailsPath(item, canFindOpenDays);
                const day = dayLabel(item.startsAt, now);
                return (
                  <li key={`${item.kind}-${item.id}`} className="db-then__row">
                    <span className="db-then__day">{path ? <Link to={path}>{day}</Link> : day}</span>
                    <span>
                      {what(item)}
                      <Signed item={item} staffing={staffing} />
                    </span>
                    {leavable(item, canSignUp) ? (
                      <LeaveButton item={item} now={now} onLeave={() => setLeaving(item)} />
                    ) : (
                      <span />
                    )}
                  </li>
                );
              })}
            </ul>
            {rest.length > after.length && (
              <p className="db-tile__meta">and {plural(rest.length - after.length, 'more commitment')}</p>
            )}
          </div>
        )}
      </div>
      <NextUpHint next={next} staffing={staffing} now={now} canSignUp={canSignUp} canFindOpenDays={canFindOpenDays} />
      <SemesterStatus staffing={staffing} canFindOpenDays={canFindOpenDays} />
      <LeaveOpenDayModal item={leaving} now={now} onClose={() => setLeaving(null)} />
    </Tile>
  );
}
