import { useState, type ComponentProps } from 'react';
import { ComboBox } from '@carbon/react';
import { fuzzyScore, fuzzySort } from '../fuzzy';

type CarbonComboBoxProps<T> = ComponentProps<typeof ComboBox<T>>;

export type FuzzyComboBoxProps<T> = Omit<CarbonComboBoxProps<T>, 'shouldFilterItem' | 'itemToString' | 'typeahead'> & {
  /** The text an item is shown and searched by. */
  itemToString: (item: T | null) => string;
};

/**
 * Carbon `ComboBox` with the fuzzy search of the Workshop pickers (`core.js` combobox): a token matches as a substring
 * or as characters in order, word starts rank higher, and the list is sorted best match first. Keyboard behaviour,
 * labels and validation are Carbon's.
 */
export function FuzzyComboBox<T>({ items, itemToString, onInputChange, ...props }: FuzzyComboBoxProps<T>) {
  const [query, setQuery] = useState('');
  const selectedText = props.selectedItem ? itemToString(props.selectedItem) : '';
  // While the input shows the selected item's text, the whole list is offered, as Carbon does by default.
  const search = query === selectedText ? '' : query;
  return (
    <ComboBox<T>
      {...props}
      items={fuzzySort(items, search, (item) => itemToString(item))}
      itemToString={itemToString}
      shouldFilterItem={({ item }) => fuzzyScore(search, itemToString(item)) > 0}
      onInputChange={(text) => {
        setQuery(text);
        onInputChange?.(text);
      }}
    />
  );
}

export interface SelectOption {
  id: string;
  label: string;
}

export type FuzzySelectFieldProps = Omit<
  FuzzyComboBoxProps<SelectOption>,
  'items' | 'itemToString' | 'selectedItem' | 'onChange' | 'value'
> & {
  options: SelectOption[];
  /** The selected option's id, or null. */
  value: string | null;
  onChange: (id: string | null) => void;
};

/** `FuzzyComboBox` for a plain id/label list, controlled by the selected id (`select()` of the Workshop forms). */
export function FuzzySelectField({ options, value, onChange, ...props }: FuzzySelectFieldProps) {
  return (
    <FuzzyComboBox<SelectOption>
      {...props}
      items={options}
      itemToString={(option) => option?.label ?? ''}
      selectedItem={options.find((option) => option.id === value) ?? null}
      onChange={({ selectedItem }) => onChange(selectedItem?.id ?? null)}
    />
  );
}
