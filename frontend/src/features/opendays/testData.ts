import type {
  OpenDay,
  OpenDayAssignment,
  OpenDayRequirementKind,
  OpenDayStaffRequirement,
} from '../../api/generated/models';

type FixtureAssignment = Omit<OpenDayAssignment, 'timeslotId'>;
type FixtureRequirement = Omit<OpenDayStaffRequirement, 'timeslotId' | 'eligible' | 'canJoin' | 'assignments'> & {
  kind: OpenDayRequirementKind;
  assignments?: FixtureAssignment[];
};

/** Fields of a test open day with one timeslot, given the old way: the day's places and the caller's assignment. */
export type OpenDayFixture = Partial<Omit<OpenDay, 'timeslots'>> & {
  requirements?: FixtureRequirement[];
  myAssignment?: FixtureAssignment | null;
};

/** Builds an open day with a single timeslot spanning the whole day. */
export function singleTimeslotDay(
  base: Omit<OpenDay, 'timeslots' | 'seriesId' | 'detachedFromSeriesId'>,
  fixture: OpenDayFixture,
): OpenDay {
  const { requirements = [], myAssignment = null, ...fields } = fixture;
  const day = { seriesId: null, detachedFromSeriesId: null, ...base, ...fields };
  const timeslotId = `${day.id.slice(0, -2)}ff`;
  const assignment = (item: FixtureAssignment): OpenDayAssignment => ({ ...item, timeslotId });
  return {
    ...day,
    timeslots: [
      {
        id: timeslotId,
        position: 0,
        startsAt: day.startsAt,
        endsAt: day.endsAt,
        myAssignment: myAssignment ? assignment(myAssignment) : null,
        requirements: requirements.map(({ assignments, ...item }) => ({
          eligible: true,
          canJoin: true,
          ...item,
          timeslotId,
          ...(assignments ? { assignments: assignments.map(assignment) } : {}),
        })),
      },
    ],
  };
}

/** Replaces the places of a single-timeslot test day. */
export function withRequirements(day: OpenDay, requirements: FixtureRequirement[]): OpenDay {
  const { timeslots, ...base } = day;
  return singleTimeslotDay(base, {
    requirements,
    myAssignment: timeslots[0]?.myAssignment ?? null,
  });
}
