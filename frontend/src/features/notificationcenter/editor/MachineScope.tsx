import { FilterableMultiSelect, RadioButton, RadioButtonGroup } from '@carbon/react';
import { useState } from 'react';
import type { NotificationCatalogOption } from '../../../api/generated/models';

type Props = {
  options: NotificationCatalogOption[];
  /** The rule's `trigger.machines`; absent or empty means every machine. */
  selected: string[];
  onChange: (machines: string[] | undefined) => void;
};

/** "All machines" or a chosen few, for triggers whose events concern one machine each. */
export function MachineScope({ options, selected, onChange }: Props) {
  // Choosing "Selected machines" before picking any is a state the definition cannot hold (empty means all).
  const [mode, setMode] = useState<'all' | 'selected'>(selected.length ? 'selected' : 'all');
  const chosen = options.filter((option) => selected.includes(option.value));
  return (
    <div className="nc-machine-scope">
      <RadioButtonGroup
        legendText="Machines"
        name="nc-machine-scope"
        orientation="horizontal"
        valueSelected={mode}
        onChange={(value) => {
          const next = value === 'selected' ? 'selected' : 'all';
          setMode(next);
          if (next === 'all') onChange(undefined);
        }}
      >
        <RadioButton id="nc-machines-all" labelText="All machines" value="all" />
        <RadioButton id="nc-machines-selected" labelText="Selected machines" value="selected" />
      </RadioButtonGroup>
      {mode === 'selected' && (
        <FilterableMultiSelect
          id="nc-machines"
          titleText="Only these machines"
          helperText="With none chosen, the rule reacts to every machine."
          placeholder="Choose machines"
          items={options}
          itemToString={(option) => option?.label ?? ''}
          selectedItems={chosen}
          onChange={({ selectedItems }) => {
            const ids = (selectedItems ?? []).map((option) => option.value);
            onChange(ids.length ? ids : undefined);
          }}
        />
      )}
    </div>
  );
}
