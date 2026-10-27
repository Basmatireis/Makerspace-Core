import { useState } from 'react';
import { Button, ComboBox, InlineLoading, RadioButton, Stack, Tag } from '@carbon/react';
import { Close } from '@carbon/icons-react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Person } from '../../../api/generated/models';
import { listPeople } from '../../../api/generated/people/people';
import { useDebouncedValue } from '../../events/useDebouncedValue';
import { peopleKeys } from '../queries';
import { MAX_MERGE_PEOPLE } from './mergeFields';
import { PersonAvatar } from '../PersonAvatar';

const personName = (person: Person) => `${person.firstName} ${person.lastName}`;

/** Step 1: who is merged, and which of them stays. */
export function MergeSelectStep({
  people,
  targetId,
  onAdd,
  onRemove,
  onTarget,
}: {
  people: Person[];
  targetId: string | null;
  onAdd: (person: Person) => void;
  onRemove: (personId: string) => void;
  onTarget: (personId: string) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const debounced = useDebouncedValue(search.trim());
  const found = useQuery({
    queryKey: [...peopleKeys.lists(), 'merge-search', debounced],
    queryFn: ({ signal }) => listPeople({ search: debounced, pageSize: 10 }, { signal }),
    enabled: debounced.length >= 2,
    placeholderData: keepPreviousData,
  });
  const selected = new Set(people.map((person) => person.id));
  const candidates = (found.data?.items ?? []).filter((person) => !selected.has(person.id));
  const full = people.length >= MAX_MERGE_PEOPLE;

  return (
    <Stack gap={6}>
      <fieldset className="people-merge__targets">
        <legend className="cds--label">Person that stays (the others are deleted)</legend>
        {people.map((person) => (
          <div key={person.id} className="people-merge__person">
            <RadioButton
              id={`merge-target-${person.id}`}
              name="merge-target"
              labelText={personName(person)}
              checked={targetId === person.id}
              onChange={() => onTarget(person.id)}
            />
            <PersonAvatar
              firstName={person.firstName}
              lastName={person.lastName}
              profileImage={person.profileImage}
              size="sm"
              decorative
            />
            {person.email && <Tag size="sm">{person.email}</Tag>}
            <Button
              kind="ghost"
              size="sm"
              hasIconOnly
              renderIcon={Close}
              iconDescription={`Remove ${personName(person)}`}
              onClick={() => onRemove(person.id)}
            />
          </div>
        ))}
      </fieldset>
      <div className="people-merge__search">
        <ComboBox<Person>
          id="merge-add-person"
          titleText="Add a person"
          helperText={full ? `At most ${MAX_MERGE_PEOPLE} people can be merged at once.` : 'Search by name or email.'}
          placeholder="Search people"
          disabled={full}
          items={candidates}
          itemToString={(person) => (person ? `${personName(person)}${person.email ? ` (${person.email})` : ''}` : '')}
          selectedItem={null}
          // The server filters, so the list is not narrowed again here.
          shouldFilterItem={() => true}
          onInputChange={setSearch}
          onChange={({ selectedItem }) => {
            if (!selectedItem) return;
            queryClient.setQueryData(peopleKeys.detail(selectedItem.id), selectedItem);
            onAdd(selectedItem);
            setSearch('');
          }}
        />
        {found.isFetching && <InlineLoading description="Searching" />}
      </div>
    </Stack>
  );
}
