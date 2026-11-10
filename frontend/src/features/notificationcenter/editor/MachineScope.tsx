import { FilterableMultiSelect, RadioButton, RadioButtonGroup } from '@carbon/react';
import type { NotificationCatalogOption } from '../../../api/generated/models';

type Props = {
  options: NotificationCatalogOption[];
  /** The rule's `trigger.machines`; absent or empty means every machine. */
  selected: string[];
  /** "Selected machines" was chosen, even if no machine is picked yet. The editor holds it so Save can refuse. */
  choosing: boolean;
  onChoosing: (choosing: boolean) => void;
  /** Selected machines without any machine chosen was refused by the editor. */
  invalid: boolean;
  onChange: (machines: string[] | undefined) => void;
};

/** "All machines" or a chosen few, for triggers whose events concern one machine each. */
export function MachineScope({ options, selected, choosing, onChoosing, invalid, onChange }: Props) {
  const selectedMode = choosing || selected.length > 0;
  const chosen = options.filter((option) => selected.includes(option.value));
  return (
    <div className="nc-machine-scope">
      <RadioButtonGroup
        legendText="Machines"
        name="nc-machine-scope"
        orientation="horizontal"
        valueSelected={selectedMode ? 'selected' : 'all'}
        onChange={(value) => {
          if (value === 'selected') {
            onChoosing(true);
          } else {
            onChoosing(false);
            onChange(undefined);
          }
        }}
      >
        <RadioButton id="nc-machines-all" labelText="All machines" value="all" />
        <RadioButton id="nc-machines-selected" labelText="Selected machines" value="selected" />
      </RadioButtonGroup>
      {selectedMode && (
        <FilterableMultiSelect
          id="nc-machines"
          titleText="Only these machines"
          placeholder="Choose machines"
          invalid={invalid}
          invalidText="Choose at least one machine"
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
