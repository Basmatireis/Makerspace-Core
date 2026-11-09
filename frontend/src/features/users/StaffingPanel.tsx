import { useState } from 'react';
import {
  Button,
  IconButton,
  InlineNotification,
  InlineLoading,
  OverflowMenu,
  OverflowMenuItem,
  Search,
  Tag,
} from '@carbon/react';
import { ArrowLeft, ArrowRight, Close } from '@carbon/icons-react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { Membership, OpenDayPeriod, Semester, SupervisorRow } from '../../api/generated/models';
import {
  assignOpenDayPerson,
  listOpenDayEligiblePeople,
  removeOpenDayAssignment,
} from '../../api/generated/open-days/open-days';
import { removeStaffingExcusal } from '../../api/generated/supervisors/supervisors';
import { ApiError } from '../../api/http-client';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../app/components/Facts';
import { formatTime } from '../../app/dateTime';
import { useNow } from '../../app/useNow';
import { dayLabel, plural } from '../dashboard/format';
import { StatusTag } from './StaffingTable';
import { labRulesGroup, labRulesLabel, membershipLabel, minimumSourceText, nextOpenDayText } from './staffing';
import { staffingKeys, staffingScheduleOptions } from './staffingQueries';
import {
  assignmentsOf,
  assignmentsVisible,
  candidatePlaces,
  periodTakesAssignments,
  type Place,
} from './staffingPlaces';

/** What the signed-in person may do from the panel. The server enforces every one of them again. */
export type PanelCan = {
  /** Assign and remove open-day assignments. */
  assign: boolean;
  /** Excuse and remove an excusal. */
  manage: boolean;
  /** Change the membership system role. */
  membership: boolean;
  /** Open the person's profile page. */
  openPerson: boolean;
  /** Read the period's schedule. */
  schedule: boolean;
};

type PanelProps = {
  row: SupervisorRow;
  semester: Semester | null;
  period: OpenDayPeriod | undefined;
  warningWindowDays: number;
  currentPersonId: string;
  can: PanelCan;
  onClose: () => void;
  onMembership: (target: Membership) => void;
  onExcuse: () => void;
  onNotify: (message: string) => void;
};

const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Check the connection and try again.';

const timeRange = (startsAt: string, endsAt: string) => `${formatTime(startsAt)}–${formatTime(endsAt)}`;

function useRefreshAfterChange() {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: staffingKeys.dashboards }),
      client.invalidateQueries({ queryKey: ['open-days'] }),
      client.invalidateQueries({ queryKey: ['dashboard'] }),
    ]);
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <IconButton label="Close details" kind="ghost" size="sm" align="left" onClick={onClose}>
      <Close />
    </IconButton>
  );
}

/** Free places the person may take, from the period's schedule. */
function AssignPlaces({
  row,
  periodId,
  warningWindowDays,
  onBack,
  onClose,
  onNotify,
}: {
  row: SupervisorRow;
  periodId: string;
  warningWindowDays: number;
  onBack: () => void;
  onClose: () => void;
  onNotify: (message: string) => void;
}) {
  const now = useNow();
  const refresh = useRefreshAfterChange();
  const [query, setQuery] = useState('');
  const schedule = useQuery(staffingScheduleOptions(periodId, true));
  const candidates = schedule.data ? candidatePlaces(schedule.data, row, now) : [];
  // Places that name extra roles are checked with the server's own eligibility search (bounded; it enforces again).
  const restricted = candidates.filter((place) => place.restricted).slice(0, 40);
  const checks = useQueries({
    queries: restricted.map((place) => ({
      queryKey: ['open-days', 'eligible-people', place.requirementId, row.name],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listOpenDayEligiblePeople(place.requirementId, { search: row.name }, { signal }),
    })),
  });
  const checking = checks.some((check) => check.isPending);
  const eligible = new Set(
    restricted.filter((_place, index) => checks[index]?.data?.items.some((person) => person.personId === row.personId)),
  );
  const places = candidates.filter((place) => !place.restricted || eligible.has(place));
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const shown = places.filter((place) => {
    const text = `${dayLabel(place.startsAt, now)} ${timeRange(place.startsAt, place.endsAt)}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });

  const assign = useMutation({
    mutationFn: (place: Place) =>
      assignOpenDayPerson(place.openDayId, { requirementId: place.requirementId, personId: row.personId }),
    onSuccess: async (_result, place) => {
      await refresh();
      onNotify(`${row.name} is assigned to ${dayLabel(place.startsAt, now)}`);
      onBack();
    },
  });

  return (
    <DetailPanel>
      <DetailPanelHead
        title="Assign to an open day"
        meta={`${row.name} · ${membershipLabel(row.membership)}`}
        secondary={`Only places ${row.name.split(' ')[0]} may take are listed`}
        actions={
          <>
            <IconButton label={`Back to ${row.name}`} kind="ghost" size="sm" align="left" onClick={onBack}>
              <ArrowLeft />
            </IconButton>
            <CloseButton onClose={onClose} />
          </>
        }
      />
      <Search
        size="md"
        labelText="Search by date or weekday"
        placeholder="e.g. Tue or 12 Nov"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {assign.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not assigned"
          subtitle={errorText(assign.error)}
        />
      )}
      {(schedule.isPending || checking) && <InlineLoading description="Loading places…" />}
      {schedule.isError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Could not load the open days" />
      )}
      {!schedule.isPending && !checking && shown.length === 0 && (
        <p className="st-secondary">No free place this person may take.</p>
      )}
      <ul className="st-places">
        {shown.map((place) => {
          const soon =
            place.kind === 'supervisor' && new Date(place.startsAt).getTime() - now <= warningWindowDays * 86_400_000;
          return (
            <li key={place.requirementId + place.timeslotId}>
              <button
                type="button"
                className="st-place"
                disabled={assign.isPending}
                onClick={() => assign.mutate(place)}
              >
                <span>
                  <strong>
                    {dayLabel(place.startsAt, now)} · {timeRange(place.startsAt, place.endsAt)}
                  </strong>
                  <small>
                    {membershipLabel(place.kind)} place · {place.taken} of {place.required} taken
                  </small>
                </span>
                {soon ? (
                  <Tag type="red" size="sm">
                    Supervisor needed
                  </Tag>
                ) : (
                  <Tag type="blue" size="sm">
                    {plural(place.required - place.taken, 'place')} free
                  </Tag>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </DetailPanel>
  );
}

function AssignmentList({
  items,
  now,
  removable,
  pending,
  onRemove,
  emptyText,
}: {
  items: ReturnType<typeof assignmentsOf>;
  now: number;
  removable: boolean;
  pending: boolean;
  onRemove: (item: ReturnType<typeof assignmentsOf>[number]) => void;
  emptyText: string;
}) {
  if (items.length === 0) return <p className="st-secondary">{emptyText}</p>;
  return (
    <ul className="st-days">
      {items.map((item) => (
        <li key={item.assignmentId}>
          <span>
            <strong>{dayLabel(item.startsAt, now)}</strong>
            <small>
              {timeRange(item.startsAt, item.endsAt)} · {membershipLabel(item.kind)}
            </small>
          </span>
          {removable && (
            <IconButton
              label={`Remove from ${dayLabel(item.startsAt, now)}`}
              kind="ghost"
              size="sm"
              align="left"
              disabled={pending}
              onClick={() => onRemove(item)}
            >
              <Close />
            </IconButton>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The selected person: facts against the minimum, their open days and the actions the viewer may take. */
export function StaffingPanel({
  row,
  semester,
  period,
  warningWindowDays,
  currentPersonId,
  can,
  onClose,
  onMembership,
  onExcuse,
  onNotify,
}: PanelProps) {
  const now = useNow();
  const navigate = useNavigate();
  const refresh = useRefreshAfterChange();
  const [assigning, setAssigning] = useState(false);
  const assignable = can.assign && semester !== null && periodTakesAssignments(period?.status);
  const schedule = useQuery(staffingScheduleOptions(semester?.periodId, can.schedule));
  const mine = schedule.data ? assignmentsOf(schedule.data, row.personId) : [];
  const upcoming = mine.filter((item) => new Date(item.endsAt).getTime() > now);
  const staffed = mine.filter((item) => new Date(item.endsAt).getTime() <= now).reverse();
  const hidden = schedule.data !== undefined && !assignmentsVisible(schedule.data);

  const remove = useMutation({
    mutationFn: (item: ReturnType<typeof assignmentsOf>[number]) =>
      removeOpenDayAssignment(item.openDayId, item.assignmentId),
    onSuccess: async () => {
      await refresh();
      onNotify(`Removed from the open day`);
    },
  });
  const unexcuse = useMutation({
    mutationFn: () => removeStaffingExcusal(semester?.periodId ?? '', row.personId),
    onSuccess: async () => {
      await refresh();
      onNotify(`${row.name} is no longer excused`);
    },
  });

  if (assigning && semester)
    return (
      <AssignPlaces
        row={row}
        periodId={semester.periodId}
        warningWindowDays={warningWindowDays}
        onBack={() => setAssigning(false)}
        onClose={onClose}
        onNotify={onNotify}
      />
    );

  const trainee = row.membership === 'trainee';
  const targets = (['supervisor', 'trainee', 'visitor'] as const).filter((target) => target !== row.membership);
  const canExcuse = can.manage && semester !== null;
  const hasMenu = can.membership || canExcuse || can.openPerson;
  const lab = labRulesGroup(row);
  const next = nextOpenDayText(row);
  const signedUp = row.staffed + row.booked;

  return (
    <DetailPanel>
      <DetailPanelHead
        title={row.name}
        meta={[membershipLabel(row.membership), ...row.extraRoles].join(' · ')}
        secondary={minimumSourceText(row)}
        helper={
          <>
            <StatusTag row={row} />
            {lab === 'not_confirmed' && (
              <Tag type="red" size="sm">
                Lab rules not confirmed
              </Tag>
            )}
          </>
        }
        actions={
          <>
            {hasMenu && (
              <OverflowMenu iconDescription={`Actions for ${row.name}`} size="sm" flipped>
                {can.openPerson && (
                  <OverflowMenuItem itemText="Open profile" onClick={() => void navigate(`/people/${row.personId}`)} />
                )}
                {can.membership &&
                  targets.map((target) => (
                    <OverflowMenuItem
                      key={target}
                      itemText={`Make ${target}`}
                      isDelete={target === 'visitor'}
                      onClick={() => onMembership(target)}
                    />
                  ))}
                {canExcuse && !row.excused && (
                  <OverflowMenuItem itemText="Excuse for this semester" onClick={onExcuse} />
                )}
                {canExcuse && row.excused && (
                  <OverflowMenuItem itemText="Remove excuse" onClick={() => unexcuse.mutate()} />
                )}
              </OverflowMenu>
            )}
            <CloseButton onClose={onClose} />
          </>
        }
      />
      {assignable && (
        <div>
          <Button kind="primary" size="md" renderIcon={ArrowRight} onClick={() => setAssigning(true)}>
            Assign to an open day
          </Button>
        </div>
      )}
      {(remove.isError || unexcuse.isError) && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not changed"
          subtitle={errorText(remove.error ?? unexcuse.error)}
        />
      )}
      {row.excused && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Excused this semester"
          subtitle={row.excusalReason || 'No reason given.'}
        />
      )}
      {row.status === 'ready' && can.membership && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title={`${row.name.split(' ')[0]} staffed ${plural(row.staffedAsTrainee, 'open day')} as trainee`}
          subtitle="Making them a supervisor swaps the system role Trainee for Supervisor. Extra roles stay."
        />
      )}
      <FactsGrid columns={2}>
        <Fact label="This semester" helper={minimumSourceText(row)}>
          {signedUp} of {row.minimum}
        </Fact>
        {trainee ? (
          <Fact label="Staffed as trainee" helper="Then ready for supervisor">
            {row.staffedAsTrainee}
          </Fact>
        ) : (
          <Fact label="System role">{membershipLabel(row.membership)}</Fact>
        )}
        <Fact label="Next open day" helper={next ? undefined : 'Nothing coming up'}>
          {next || '—'}
        </Fact>
        <Fact
          label="Lab rules"
          helper={
            lab === 'not_confirmed' &&
            (row.personId === currentPersonId ? (
              <Link to="/lab-rules/confirm">Confirm now</Link>
            ) : (
              'They confirm it themselves in the app or at the tablet.'
            ))
          }
        >
          {labRulesLabel(row)}
        </Fact>
      </FactsGrid>
      {can.schedule && (
        <>
          <DetailPanelSection title={`Coming up (${upcoming.length})`}>
            {schedule.isPending ? (
              <InlineLoading description="Loading open days…" />
            ) : hidden ? (
              <p className="st-secondary">Assignments are not visible with your permissions.</p>
            ) : (
              <AssignmentList
                items={upcoming}
                now={now}
                removable={can.assign && semester !== null && periodTakesAssignments(period?.status)}
                pending={remove.isPending}
                onRemove={(item) => remove.mutate(item)}
                emptyText="Not signed up for anything yet."
              />
            )}
          </DetailPanelSection>
          {!hidden && !schedule.isPending && (
            <DetailPanelSection title={`Staffed (${staffed.length})`}>
              <AssignmentList
                items={staffed}
                now={now}
                removable={false}
                pending={false}
                onRemove={() => undefined}
                emptyText="Nothing staffed this semester."
              />
            </DetailPanelSection>
          )}
        </>
      )}
    </DetailPanel>
  );
}
