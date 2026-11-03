/* eslint-disable react-refresh/only-export-components -- the period hook and the pieces it renders belong together */
import { useState, type ReactNode } from 'react';
import { DismissibleTag, Modal, RadioButton, RadioButtonGroup } from '@carbon/react';
import type { FilterCategory } from '../../app/BatchFilter';
import { DateInput } from '../../app/DateInput';
import { dateInAppTimeZone } from '../../app/dateTime';
import { useUrlState } from '../machinelogbook/shared/DirectoryTable';
import { parsePreset, periodOptions, resolvePeriod, type Period } from './period';

const PERIOD_KEYS = ['period', 'from', 'to'];

/**
 * The period filter of both Payments tabs, kept in the URL (`period`, and `from`/`to` for a custom range). "Custom
 * range…" opens a small dialog for the two days instead of staging them in the filter panel.
 */
export function usePeriodFilter() {
  const url = useUrlState('');
  // Open while the custom range dialog is shown; holds the filter panel's staging function so a panel that is still
  // open stages the same range the dialog applies.
  const [custom, setCustom] = useState<{ stage: (key: string, value: string[]) => void } | null>(null);
  const period = resolvePeriod(parsePreset(url.get('period')), url.get('from'), url.get('to'));
  const clear = () => url.clear(PERIOD_KEYS);

  const category: FilterCategory = {
    key: 'period',
    label: 'Period',
    // Only the preset counts as an applied filter. The days of a custom range come from the dialog; under any other
    // preset they are ignored.
    render: ({ idPrefix, staged, set }) => (
      <RadioButtonGroup
        legendText={<span className="cds--visually-hidden">Period</span>}
        name={`${idPrefix}-preset`}
        orientation="vertical"
        valueSelected={parsePreset(staged.period?.[0])}
        onChange={(value) => {
          if (value === 'custom') {
            setCustom({ stage: set });
            return;
          }
          set('period', value === 'all' ? [] : [String(value)]);
        }}
      >
        {periodOptions.map((option) => (
          <RadioButton
            key={option.id}
            id={`${idPrefix}-${option.id}`}
            value={option.id}
            labelText={option.id === 'custom' && period.preset === 'custom' ? period.note : option.label}
          />
        ))}
      </RadioButtonGroup>
    ),
  };

  const tag =
    period.preset === 'all' ? null : (
      <DismissibleTag
        type="blue"
        size="md"
        text={period.preset === 'custom' ? period.note : period.label}
        title="Show all time"
        dismissTooltipLabel="Show all time"
        onClose={clear}
      />
    );

  const note = (
    <p className="sales-period-note" aria-live="polite">
      <strong>{period.label}</strong> · {period.note}
    </p>
  );

  const dialog = custom ? (
    <CustomRangeModal
      period={period}
      onClose={() => setCustom(null)}
      onApply={(from, to) => {
        custom.stage('period', ['custom']);
        url.set({ period: 'custom', from, to });
        setCustom(null);
      }}
    />
  ) : null;

  return { period, category, tag, note, dialog, clear };
}

/**
 * The applied filters as removable tags at the start of the table toolbar: the period first, then every chosen option
 * of the other filters.
 */
export function FilterTags({
  period,
  categories,
}: {
  period: ReactNode;
  categories: { key: string; label: string; options?: { id: string; label: string }[] }[];
}) {
  const url = useUrlState('');
  const chosen = categories.flatMap((category) =>
    (category.options ?? [])
      .filter((option) => url.list(category.key).includes(option.id))
      .map((option) => ({ category, option })),
  );
  if (!period && chosen.length === 0) return null;
  return (
    <div className="sales-filter-tags">
      {period}
      {chosen.map(({ category, option }) => (
        <DismissibleTag
          key={`${category.key}-${option.id}`}
          type="gray"
          size="md"
          text={option.label}
          title={`Remove ${option.label}`}
          dismissTooltipLabel={`Remove ${option.label}`}
          onClose={() =>
            url.set({
              [category.key]:
                url
                  .list(category.key)
                  .filter((id) => id !== option.id)
                  .join(',') || null,
            })
          }
        />
      ))}
    </div>
  );
}

/** From and Through as whole days; From must not be after Through. */
function CustomRangeModal({
  period,
  onApply,
  onClose,
}: {
  period: Period;
  onApply: (from: string, to: string) => void;
  onClose: () => void;
}) {
  const today = dateInAppTimeZone(new Date());
  const [from, setFrom] = useState(period.from ?? `${today.slice(0, 8)}01`);
  const [to, setTo] = useState(period.to ?? today);
  const [tried, setTried] = useState(false);
  const fromError = !from ? 'Choose the first day' : from > to && to ? 'From must not be after Through' : null;
  const toError = !to ? 'Choose the last day' : null;
  return (
    <Modal
      open
      size="sm"
      modalLabel="Payments"
      modalHeading="Custom range"
      primaryButtonText="Apply"
      secondaryButtonText="Cancel"
      onRequestClose={onClose}
      onRequestSubmit={() => {
        setTried(true);
        if (!fromError && !toError) onApply(from, to);
      }}
    >
      <div className="sales-form-grid">
        <DateInput
          id="payments-range-from"
          labelText="From"
          value={from}
          onChange={setFrom}
          invalid={tried && !!fromError}
          invalidText={fromError ?? undefined}
          required
        />
        <DateInput
          id="payments-range-to"
          labelText="Through"
          value={to}
          onChange={setTo}
          invalid={tried && !!toError}
          invalidText={toError ?? undefined}
          required
        />
      </div>
      <p className="sales-secondary sales-top-gap">
        Whole days. The expected cash counts everything up to the end of the range.
      </p>
    </Modal>
  );
}
