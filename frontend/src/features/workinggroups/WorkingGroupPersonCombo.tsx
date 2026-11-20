import { ComboBox } from '@carbon/react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useDebouncedValue } from '../events/useDebouncedValue';
import { workingGroupPeopleOptions } from './queries';

export type PersonChoice = { id: string; label: string };

/** Search-as-you-type person picker over `listWorkingGroupPeople` (names only). */
export function WorkingGroupPersonCombo({
  id,
  titleText,
  helperText,
  value,
  onChange,
  suggestions,
  invalid,
  invalidText,
}: {
  id: string;
  titleText: string;
  helperText?: string;
  value: PersonChoice | null;
  onChange: (choice: PersonChoice | null) => void;
  /** Offered before the person types anything, for example the members of the group. */
  suggestions?: PersonChoice[];
  invalid?: boolean;
  invalidText?: string;
}) {
  const [search, setSearch] = useState('');
  // People are fetched only once the field was used, so a closed dialog costs no request.
  const [used, setUsed] = useState(false);
  const debounced = useDebouncedValue(search.trim());
  const people = useQuery({
    ...workingGroupPeopleOptions(debounced),
    enabled: used,
    placeholderData: keepPreviousData,
  });
  const found = (people.data?.items ?? []).map((person) => ({ id: person.id, label: person.displayName }));
  const items = [...(suggestions ?? []), ...found].filter(
    (item, index, all) => all.findIndex((other) => other.id === item.id) === index,
  );
  if (value && !items.some((item) => item.id === value.id)) items.unshift(value);
  return (
    <div onFocusCapture={() => setUsed(true)}>
      <ComboBox<PersonChoice>
        autoAlign
        id={id}
        titleText={titleText}
        helperText={helperText}
        placeholder="Search by name"
        items={items}
        itemToString={(item) => item?.label ?? ''}
        selectedItem={value}
        // The server filters, so the list is not narrowed again here.
        shouldFilterItem={() => true}
        onInputChange={setSearch}
        onChange={({ selectedItem }) => onChange(selectedItem ?? null)}
        invalid={invalid}
        invalidText={invalidText}
      />
    </div>
  );
}
