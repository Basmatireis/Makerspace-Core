import { ActionableNotification, Button, InlineNotification, Tile } from '@carbon/react';
import { ArrowRight, Calendar } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { joinOpenDay } from '../../api/generated/open-days/open-days';
import type { ComingUpItem, PersonalDashboardStaffing } from '../../api/generated/models';
import { countdown, plural, when } from './format';
import { dashboardKeys } from './queries';

type Props = {
  next: ComingUpItem | null;
  total: number;
  staffing: PersonalDashboardStaffing | undefined;
  now: number;
  canSignUp: boolean;
  canFindOpenDays: boolean;
};

/**
 * The tile's single info box. Supervisors: their next open day is short of supervisors, otherwise the next open day
 * with a free supervisor place. Trainees: the next free trainee place (empty trainee places never matter to
 * supervisors, so the API only reports shortage for supervisor places).
 */
function NextUpHint({ next, staffing, now, canSignUp }: Pick<Props, 'next' | 'staffing' | 'now' | 'canSignUp'>) {
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
        subtitle="The open day is on your list below."
      />
    );
  }
  if (!staffing) return null;

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

export function NextUpTile(props: Props) {
  const { next, total, now, canFindOpenDays } = props;
  const hint = <NextUpHint {...props} />;
  if (!next) {
    return (
      <Tile className="db-tile">
        <span className="db-tile__eyebrow">
          <Calendar size={16} aria-hidden />
          Next up
        </span>
        <p className="db-tile__title">Nothing booked yet</p>
        <p className="db-tile__meta">Open days need supervisors and trainees. Pick something that fits your week.</p>
        {hint}
        {canFindOpenDays && (
          <div className="db-tile__actions">
            <Button as={Link} to="/open-days" kind="ghost" size="sm" renderIcon={ArrowRight}>
              Find open days
            </Button>
          </div>
        )}
      </Tile>
    );
  }
  const openDay = next.kind === 'open_day';
  return (
    <Tile className="db-tile">
      <span className="db-tile__eyebrow">
        <Calendar size={16} aria-hidden />
        Next up{total > 1 ? ` · 1 of ${total} upcoming` : ''}
      </span>
      <p className="db-countdown">{countdown(next.startsAt, next.endsAt, now)}</p>
      <p className="db-tile__title">{next.title}</p>
      <p className="db-tile__meta">
        {when(next.startsAt, next.endsAt, now)} · {openDay ? 'Open day' : 'Event shift'}
      </p>
      {hint}
      {!openDay && next.publicId && (
        <div className="db-tile__actions">
          <Button as={Link} to={`/events/public/${next.publicId}`} kind="ghost" size="sm" renderIcon={ArrowRight}>
            Event details
          </Button>
        </div>
      )}
    </Tile>
  );
}
