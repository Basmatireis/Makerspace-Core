/* eslint-disable react-refresh/only-export-components -- the filter component and its value helpers belong together */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Button, Checkbox, CheckboxGroup, Popover, PopoverContent } from '@carbon/react';
import { Filter } from '@carbon/icons-react';
import './batchFilter.scss';

/** Staged or applied selection: category key -> chosen ids. Single-value criteria (a date, one customer) use a list of at most one id. */
export type FilterValues = Record<string, string[]>;

export type FilterCategory = {
  key: string;
  /** Column heading and checkbox group legend. */
  label: string;
  options?: { id: string; label: string }[];
  helperText?: string;
  /** Every key this category writes; defaults to `[key]`. A custom column may own several (a date range). */
  keys?: string[];
  /** Replaces the checkbox list, e.g. with dates or a combobox. */
  render?: (context: { idPrefix: string; staged: FilterValues; set: (key: string, value: string[]) => void }) => ReactNode;
};

type Props = {
  /** Unique per table: element ids. */
  id: string;
  /** Names the panel for assistive technology, e.g. "Jobs". */
  label: string;
  categories: FilterCategory[];
  applied: FilterValues;
  onApply: (values: FilterValues) => void;
  onReset: () => void;
};

const keysOf = (category: FilterCategory) => category.keys ?? [category.key];

/** Reads a comma separated URL parameter as the list this component works with. */
export const toList = (value: string | null | undefined) => (value ?? '').split(',').filter(Boolean);
/** Turns applied values into a URL parameter patch (empty -> null). */
export const toPatch = (values: FilterValues, keys: string[]) => Object.fromEntries(keys.map((key) => [key, (values[key] ?? []).join(',') || null]));

/**
 * Carbon "multiple filters with batch updates": the toolbar filter button opens a panel of filter columns. Choices are
 * staged inside the panel and only reach the table through "Apply filters".
 */
export function BatchFilter({ id, label, categories, applied, onApply, onReset }: Props) {
  const [open, setOpen] = useState(false);
  const [staged, setStaged] = useState<FilterValues>(applied);
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const count = categories.reduce((total, category) => total + keysOf(category).reduce((sum, key) => sum + (applied[key]?.length ?? 0), 0), 0);

  const close = (returnFocus: boolean) => { setOpen(false); if (returnFocus) trigger.current?.focus(); };
  const toggle = () => {
    if (open) { close(false); return; }
    setStaged(applied);
    setOpen(true);
  };

  useEffect(() => { if (open) panel.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    // The date picker's calendar lives outside the panel, so it counts as inside.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target && (wrapper.current?.contains(target) || target.closest('.flatpickr-calendar'))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const set = (key: string, value: string[]) => setStaged((current) => ({ ...current, [key]: value }));
  const toggleOption = (key: string, optionId: string, checked: boolean) => setStaged((current) => {
    const list = current[key] ?? [];
    return { ...current, [key]: checked ? [...list.filter((item) => item !== optionId), optionId] : list.filter((item) => item !== optionId) };
  });
  const apply = () => { onApply(staged); close(true); };
  const reset = () => { setStaged({}); onReset(); };

  return (
    <div
      ref={wrapper} className="mj-batch-filter"
      onKeyDown={(event) => { if (event.key === 'Escape' && open && !(event.target as Element).closest('.flatpickr-calendar')) { event.stopPropagation(); close(true); } }}
    >
      <Popover open={open} align="bottom-end" isTabTip className="mj-batch-filter__popover">
        <Button
          ref={trigger} hasIconOnly kind="ghost" size="md" renderIcon={Filter} tooltipPosition="bottom"
          className={`mj-batch-filter__trigger${open ? ' mj-batch-filter__trigger--open' : ''}${count ? ' mj-batch-filter__trigger--active' : ''}`}
          iconDescription={count ? `Filters (${count} applied)` : 'Filters'} aria-expanded={open} aria-controls={`${id}-filters`} onClick={toggle}
        />
        {count > 0 && <span className="mj-batch-filter__badge" aria-hidden="true">{count}</span>}
        <PopoverContent>
          <div id={`${id}-filters`} ref={panel} className="mj-batch-filter__panel" role="group" aria-labelledby={headingId} tabIndex={-1}>
            <h2 id={headingId} className="cds--visually-hidden">{label} filters</h2>
            <div className="mj-batch-filter__columns" style={{ '--mj-batch-filter-columns': Math.min(categories.length, 3) } as React.CSSProperties}>
              {categories.map((category) => (
                <div key={category.key} className="mj-batch-filter__column">
                  {category.render
                    ? <div className="mj-batch-filter__custom"><p className="mj-batch-filter__label">{category.label}</p>{category.render({ idPrefix: `${id}-${category.key}`, staged, set })}</div>
                    : (
                      <CheckboxGroup legendText={category.label} helperText={category.helperText}>
                        {(category.options ?? []).map((option) => (
                          <Checkbox
                            key={option.id} id={`${id}-${category.key}-${option.id}`} labelText={option.label}
                            checked={(staged[category.key] ?? []).includes(option.id)} onChange={(_event, { checked }) => toggleOption(category.key, option.id, checked)}
                          />
                        ))}
                      </CheckboxGroup>
                    )}
                </div>
              ))}
            </div>
            <div className="mj-batch-filter__footer">
              <Button kind="secondary" size="xl" onClick={reset}>Reset filters</Button>
              <Button kind="primary" size="xl" onClick={apply}>Apply filters</Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
