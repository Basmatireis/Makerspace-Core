import { useState } from 'react';
import { Button, Checkbox, CheckboxGroup, Popover, PopoverContent } from '@carbon/react';
import { Filter } from '@carbon/icons-react';
import { activeFilterCount, type FilterDef, type FilterKey, type FilterValues } from '../model/filters';

/**
 * The visible "Filters" button of the Open Days toolbars, with a red count of the chosen options. Choices apply at
 * once; the panel is a Carbon popover with one checkbox group per category.
 */
export function OpenDayFilters({
  defs,
  values,
  onChange,
}: {
  defs: FilterDef[];
  values: FilterValues;
  onChange: (values: FilterValues) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(values);
  const toggle = (key: FilterKey, id: string, checked: boolean) => {
    const current = values[key] ?? [];
    onChange({ ...values, [key]: checked ? [...current, id] : current.filter((item) => item !== id) });
  };
  return (
    <div
      className="od-filters"
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
          className={`od-filters__button${count ? ' is-active' : ''}`}
          onClick={() => setOpen((value) => !value)}
        >
          Filters
          {count > 0 && (
            <span className="od-filters__count" aria-label={`${count} applied`}>
              {count}
            </span>
          )}
        </Button>
        <PopoverContent>
          {open && (
            <div className="od-filters__panel" role="group" aria-label="Filters">
              <div className="od-filters__columns">
                {defs
                  .filter((def) => def.options.length)
                  .map((def) => (
                    <CheckboxGroup key={def.key} legendText={def.label}>
                      {def.options.map((option) => (
                        <Checkbox
                          key={option.id}
                          id={`od-filter-${def.key}-${option.id}`}
                          labelText={option.label}
                          checked={(values[def.key] ?? []).includes(option.id)}
                          onChange={(_event, { checked }) => toggle(def.key, option.id, checked)}
                        />
                      ))}
                    </CheckboxGroup>
                  ))}
              </div>
              <div className="od-filters__footer">
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
