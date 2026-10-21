import { ComboBox } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { EventPersonOption } from '../../../api/generated/models';
import { eventPeopleQueryOptions } from '../queries';
import { useDebouncedValue } from '../useDebouncedValue';

export type PersonChoice = { id: string; label: string };
const personChoice = (person: EventPersonOption): PersonChoice => ({
  id: person.id,
  label: `${person.firstName} ${person.lastName}`,
});

/** Search-as-you-type person picker over the people an event may use. */
export function PersonCombo({
  id,
  titleText,
  helperText,
  placeholder = 'Search by name',
  value,
  onChange,
  suggestions,
  invalid,
  invalidText,
}: {
  id: string;
  titleText: string;
  helperText?: string;
  placeholder?: string;
  value: PersonChoice | null;
  onChange: (choice: PersonChoice | null) => void;
  /** Shown before the person types anything, for example the matches of a public signup. */
  suggestions?: PersonChoice[];
  invalid?: boolean;
  invalidText?: string;
}) {
  const [search, setSearch] = useState('');
  // People are only fetched once the field was used, so a closed dialog or filter panel costs no request.
  const [used, setUsed] = useState(false);
  const debounced = useDebouncedValue(search.trim());
  const people = useQuery({
    ...eventPeopleQueryOptions(debounced),
    enabled: used,
    placeholderData: keepPreviousData,
  });
  const items = (people.data?.items ?? []).map(personChoice);
  const merged = [...(suggestions ?? []), ...items].filter(
    (item, index, all) => all.findIndex((other) => other.id === item.id) === index,
  );
  if (value && !merged.some((item) => item.id === value.id)) merged.unshift(value);
  return (
    <div onFocusCapture={() => setUsed(true)}>
      <ComboBox<PersonChoice>
        autoAlign
        id={id}
        titleText={titleText}
        helperText={helperText}
        placeholder={placeholder}
        items={merged}
        itemToString={(item) => item?.label ?? ''}
        selectedItem={value}
        // Filtering happens on the server, so the list is not narrowed again here.
        shouldFilterItem={() => true}
        onInputChange={setSearch}
        onChange={({ selectedItem }) => onChange(selectedItem ?? null)}
        invalid={invalid}
        invalidText={invalidText}
      />
    </div>
  );
}
