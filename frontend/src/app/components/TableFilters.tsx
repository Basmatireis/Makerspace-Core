import { useId, useState } from 'react';
import { Button, Checkbox, CheckboxGroup, Popover, PopoverContent } from '@carbon/react';
import { Filter } from '@carbon/icons-react';
import './blocks.scss';
import { countFilterChoices, type FilterGroup, type FilterSelection } from './filterChoices';

/**
 * The visible "Filters" button of a table toolbar with a red count of the chosen options. Choices apply at once; the
 * panel is a Carbon popover with one checkbox group per category (categories without options are left out).
 */
export function TableFilters<K extends string>({
  defs,
  values,
  onChange,
  label = 'Filters',
}: {
  defs: FilterGroup<K>[];
  values: FilterSelection<K>;
  onChange: (values: FilterSelection<K>) => void;
  /** Accessible name of the popover panel. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const idPrefix = useId();
  const count = countFilterChoices(values);
  const toggle = (key: K, id: string, checked: boolean) => {
    const current = values[key] ?? [];
    onChange({ ...values, [key]: checked ? [...current, id] : current.filter((item) => item !== id) });
  };
  return (
    <div
      className="table-filters"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Popover open={open} align="bottom-end" isTabTip onRequestClose={() => setOpen(false)} dropShadow>
        <Button
          kind="ghost"
          size="lg"
          renderIcon={Filter}
          aria-expanded={open}
          className={`table-filters__button${count ? ' is-active' : ''}`}
          onClick={() => setOpen((value) => !value)}
        >
          Filters
          {count > 0 && (
            <span className="table-filters__count" aria-label={`${count} applied`}>
              {count}
            </span>
          )}
        </Button>
        <PopoverContent>
          {open && (
            <div className="table-filters__panel" role="group" aria-label={label}>
              <div className="table-filters__columns">
                {defs
                  .filter((def) => def.options.length)
                  .map((def) => (
                    <CheckboxGroup key={def.key} legendText={def.label}>
                      {def.options.map((option) => (
                        <Checkbox
                          key={option.id}
                          id={`${idPrefix}-${def.key}-${option.id}`}
                          labelText={option.label}
                          checked={(values[def.key] ?? []).includes(option.id)}
                          onChange={(_event, { checked }) => toggle(def.key, option.id, checked)}
                        />
                      ))}
                    </CheckboxGroup>
                  ))}
              </div>
              <div className="table-filters__footer">
                <Button kind="ghost" size="md" disabled={!count} onClick={() => onChange({})}>
                  Clear filters
                </Button>
                <Button kind="primary" size="md" onClick={() => setOpen(false)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
