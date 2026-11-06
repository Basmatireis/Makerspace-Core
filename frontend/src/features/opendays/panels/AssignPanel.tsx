import { useState } from 'react';
import { ContainedList, ContainedListItem, IconButton, Search, Tag } from '@carbon/react';
import { ArrowLeft } from '@carbon/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { OpenDay, OpenDayStaffRequirement, OpenDayTimeslot, SupervisorRow } from '../../../api/generated/models';
import { DetailPanel, DetailPanelHead } from '../../../app/components/DetailPanel';
import { dateOf, shortDate, timeRange } from '../model/dates';
import { sortCandidates, type Candidate } from '../model/candidates';
import { free } from '../model/state';
import { eligiblePeopleQueryOptions } from '../queries';

/** Assign an eligible person to a free place. The list is searched on the server. */
export function AssignPanel({
  day,
  slot,
  requirement,
  rows,
  busy,
  onBack,
  onPick,
}: {
  day: OpenDay;
  slot: OpenDayTimeslot;
  requirement: OpenDayStaffRequirement;
  rows: ReadonlyMap<string, SupervisorRow>;
  busy: boolean;
  onBack: () => void;
  onPick: (person: Candidate) => void;
}) {
  const [search, setSearch] = useState('');
  const people = useQuery({ ...eligiblePeopleQueryOptions(requirement.id, search), placeholderData: keepPreviousData });
  const items = sortCandidates(people.data?.items ?? [], rows);
  const kind = requirement.kind === 'supervisor' ? 'supervisor' : 'trainee';
  return (
    <DetailPanel className="od-detail">
      <DetailPanelHead
        title={`Assign ${kind}`}
        meta={`${shortDate(dateOf(day.startsAt))} · ${timeRange(slot.startsAt, slot.endsAt)}`}
        secondary={`${free(requirement)} of ${requirement.requiredCount} places free · people below their minimum first`}
        actions={
          <IconButton kind="ghost" size="md" label="Back to open day" onClick={onBack}>
            <ArrowLeft />
          </IconButton>
        }
      />
      <Search
        id="od-assign-search"
        labelText="Search eligible people"
        placeholder="Name"
        size="md"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div data-guide="open-days-eligible-person">
        <ContainedList label="Eligible people" kind="on-page">
          {items.map((person) => {
            const row = rows.get(person.personId);
            return (
              <ContainedListItem key={person.personId} onClick={() => !busy && onPick(person)}>
                <span className="od-cand">
                  <span>{person.displayName}</span>
                  {row && (
                    <Tag size="sm" type={row.missing > 0 ? 'red' : 'gray'}>
                      {row.minimum
                        ? `${row.staffed + row.booked} of ${row.minimum}`
                        : `${row.staffed + row.booked} this semester`}
                    </Tag>
                  )}
                </span>
              </ContainedListItem>
            );
          })}
        </ContainedList>
      </div>
      {people.isPending && <p className="od-hint">Loading eligible people…</p>}
      {people.isError && <p className="od-field-error">The list could not be loaded.</p>}
      {people.data && !items.length && <p className="od-hint">No eligible person matches.</p>}
    </DetailPanel>
  );
}
