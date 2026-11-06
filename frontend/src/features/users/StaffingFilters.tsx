import { useState } from 'react';
import { Button, Checkbox, CheckboxGroup, Popover, PopoverContent } from '@carbon/react';
import { Filter } from '@carbon/icons-react';
import { activeFilterCount, type FilterDef, type FilterKey, type StaffingFilterValues } from './staffing';

/**
 * The visible "Filters" button of the staffing table with a red count of the chosen options. Choices apply at once;
 * the panel is a Carbon popover with one checkbox group per category.
 */
export function StaffingFilters({
  defs,
  values,
  onChange,
}: {
  defs: FilterDef[];
  values: StaffingFilterValues;
  onChange: (values: StaffingFilterValues) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(values);
  const toggle = (key: FilterKey, id: string, checked: boolean) => {
    const current = values[key] ?? [];
    onChange({ ...values, [key]: checked ? [...current, id] : current.filter((item) => item !== id) });
  };
  return (
    <div
      className="st-filters"
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
          className={`st-filters__button${count ? ' is-active' : ''}`}
          onClick={() => setOpen((value) => !value)}
        >
          Filters
          {count > 0 && (
            <span className="st-filters__count" aria-label={`${count} applied`}>
              {count}
            </span>
          )}
        </Button>
        <PopoverContent>
          {open && (
            <div className="st-filters__panel" role="group" aria-label="Staffing filters">
              <div className="st-filters__columns">
                {defs.map((def) => (
                  <CheckboxGroup key={def.key} legendText={def.label}>
                    {def.options.map((option) => (
                      <Checkbox
                        key={option.id}
                        id={`st-filter-${def.key}-${option.id}`}
                        labelText={option.label}
                        checked={(values[def.key] ?? []).includes(option.id)}
                        onChange={(_event, { checked }) => toggle(def.key, option.id, checked)}
                      />
                    ))}
                  </CheckboxGroup>
                ))}
              </div>
              <div className="st-filters__footer">
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
