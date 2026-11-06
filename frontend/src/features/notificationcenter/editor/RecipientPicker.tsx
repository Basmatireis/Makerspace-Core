import { DismissibleTag, MultiSelect } from '@carbon/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { listPeople } from '../../../api/generated/people/people';
import type { NotificationCatalog } from '../../../api/generated/models';
import { FuzzyComboBox } from '../../../app/components/FuzzyComboBox';
import { fullRoleCatalogOptions } from '../../roles/queries';
import { peopleKeys, personOptions } from '../../users/queries';
import { recipientGroups, type Definition } from '../ruleModel';
import { recipientLabel, type NameLookup } from '../ruleText';

type Item = { id: string; label: string };
type PersonItem = { id: string; label: string };

type Props = {
  id: string;
  catalog: NotificationCatalog;
  definition: Definition;
  lookup: NameLookup;
  value: string[];
  onChange: (next: string[]) => void;
};

/** Dynamic recipients of the rule's context and roles in one multi-select; people are found by search. */
export function RecipientPicker({ id, catalog, definition, lookup, value, onChange }: Props) {
  const queryClient = useQueryClient();
  const roles = useQuery(fullRoleCatalogOptions);
  const [search, setSearch] = useState('');
  const items: Item[] = [
    ...recipientGroups(catalog, definition).flatMap((group) =>
      group.choices.map((choice) => ({ id: choice.key, label: `${group.label}: ${choice.label}` })),
    ),
    ...(roles.data ?? []).map((role) => ({ id: `role:${role.id}`, label: `Role: ${role.name}` })),
  ];
  const itemIds = new Set(items.map((item) => item.id));
  const selected = items.filter((item) => value.includes(item.id));
  const people = value.filter((key) => key.startsWith('person:'));
  // Keys the context no longer offers stay visible so they can be removed.
  const stray = value.filter((key) => !itemIds.has(key) && !key.startsWith('person:'));
  const found = useQuery({
    queryKey: [...peopleKeys.lists(), 'recipient-search', search],
    queryFn: ({ signal }) => listPeople({ search, pageSize: 8 }, { signal }),
    enabled: search.trim().length >= 2,
  });
  const candidates: PersonItem[] = (found.data?.items ?? [])
    .filter((person) => !value.includes(`person:${person.id}`))
    .map((person) => ({ id: person.id, label: `${person.firstName} ${person.lastName}` }));
  const remove = (key: string) => onChange(value.filter((entry) => entry !== key));

  return (
    <div className="nc-recipients">
      <MultiSelect<Item>
        id={`${id}-recipients`}
        titleText="To"
        label="Choose recipients"
        items={items}
        itemToString={(item) => item?.label ?? ''}
        selectedItems={selected}
        onChange={({ selectedItems }) =>
          onChange([...(selectedItems ?? []).map((item) => item.id), ...people, ...stray])
        }
      />
      <FuzzyComboBox<PersonItem>
        id={`${id}-person`}
        titleText="Add a person"
        placeholder="Search by name"
        items={candidates}
        itemToString={(item) => item?.label ?? ''}
        selectedItem={null}
        onInputChange={setSearch}
        onChange={({ selectedItem: item }) => {
          if (!item) return;
          const person = found.data?.items.find((candidate) => candidate.id === item.id);
          if (person) queryClient.setQueryData(personOptions(person.id).queryKey, person);
          onChange([...value, `person:${item.id}`]);
          setSearch('');
        }}
      />
      {[...people, ...stray].length > 0 && (
        <div className="nc-recipients__tags">
          {[...people, ...stray].map((key) => (
            <DismissibleTag
              key={key}
              type={key.startsWith('person:') ? 'gray' : 'warm-gray'}
              size="md"
              text={recipientLabel(key, catalog, definition, lookup)}
              title={`Remove ${recipientLabel(key, catalog, definition, lookup)}`}
              onClose={() => remove(key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
