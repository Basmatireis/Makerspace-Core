import { ContainedList, ContainedListItem, Tile } from '@carbon/react';
import { Calendar } from '@carbon/icons-react';
import type { PublicOpenDay } from '../../api/generated/models';
import { CompetencyTags } from '../trainings/CompetencyTags';
import { countdown, when } from './format';

export function NextOpenDayTile({ next, now }: { next: PublicOpenDay | undefined; now: number }) {
  return (
    <Tile className="db-tile">
      <span className="db-tile__eyebrow">
        <Calendar size={16} aria-hidden />
        Next open day
      </span>
      {next ? (
        <>
          <p className="db-countdown">{countdown(next.startsAt, next.endsAt, now)}</p>
          <p className="db-tile__title">{when(next.startsAt, next.endsAt, now)}</p>
          <CompetencyTags competencies={next.competencies ?? []} limit={4} size="sm" />
          <p className="db-tile__meta">No sign-up needed. Supervisors help you with the machines.</p>
        </>
      ) : (
        <p className="db-tile__meta">No open days are scheduled right now.</p>
      )}
    </Tile>
  );
}

export function UpcomingOpenDaysList({ days, now }: { days: PublicOpenDay[]; now: number }) {
  return (
    <ContainedList label="Upcoming open days" kind="on-page" className="db-panel">
      {days.length === 0 ? (
        <ContainedListItem>
          <span className="db-panel__empty">No open days are scheduled right now.</span>
        </ContainedListItem>
      ) : (
        days.slice(0, 6).map((day) => (
          <ContainedListItem key={day.id} renderIcon={Calendar}>
            {when(day.startsAt, day.endsAt, now)}
            <CompetencyTags competencies={day.competencies ?? []} limit={3} size="sm" />
          </ContainedListItem>
        ))
      )}
    </ContainedList>
  );
}
