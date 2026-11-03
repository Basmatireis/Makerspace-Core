import { useState } from 'react';
import { DatePicker, DatePickerInput, Dropdown, IconButton, Modal } from '@carbon/react';
import { Calendar } from '@carbon/icons-react';
import { APP_DATE_PLACEHOLDER, parseDisplayDate, pickerDateToDateOnly } from '../../../app/dateTime';
import { usePickerDateRange } from '../../../app/usePickerDateRange';
import { PERIODS, rangeLabel, rangeProblem, type DateRange, type Period } from './period';

/** The custom period dialog: one Carbon range picker with whole days in the workshop's time zone. */
function CustomPeriodModal({
  initial,
  onApply,
  onClose,
}: {
  initial: DateRange;
  onApply: (range: DateRange) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const value = usePickerDateRange(draft.from, draft.to);
  const problem = rangeProblem(draft);
  return (
    <Modal
      open
      size="sm"
      modalHeading="Custom period"
      primaryButtonText="Apply"
      secondaryButtonText="Cancel"
      onRequestClose={onClose}
      onRequestSubmit={() => {
        setSubmitted(true);
        if (!problem) onApply(draft);
      }}
    >
      <div className="stats-period-modal">
        <DatePicker
          allowInput
          datePickerType="range"
          dateFormat="d.m.Y"
          locale="en"
          value={value}
          onChange={(dates) =>
            setDraft({
              from: dates[0] ? pickerDateToDateOnly(dates[0]) : '',
              to: dates[1] ? pickerDateToDateOnly(dates[1]) : '',
            })
          }
        >
          <DatePickerInput
            id="stats-period-from"
            labelText="From"
            placeholder={APP_DATE_PLACEHOLDER}
            pattern="\d{2}\.\d{2}\.\d{4}"
            invalid={submitted && Boolean(problem)}
            invalidText={problem ?? undefined}
            onChange={(event) => {
              const parsed = parseDisplayDate(event.target.value);
              if (parsed || !event.target.value) setDraft((current) => ({ ...current, from: parsed ?? '' }));
            }}
          />
          <DatePickerInput
            id="stats-period-to"
            labelText="To"
            placeholder={APP_DATE_PLACEHOLDER}
            pattern="\d{2}\.\d{2}\.\d{4}"
            onChange={(event) => {
              const parsed = parseDisplayDate(event.target.value);
              if (parsed || !event.target.value) setDraft((current) => ({ ...current, to: parsed ?? '' }));
            }}
          />
        </DatePicker>
        <p className="stats-card__note">
          Whole days in the workshop&apos;s time zone; the comparison uses the same number of days before the start.
        </p>
      </div>
    </Modal>
  );
}

/** Period presets plus a custom range; choosing the custom range opens a dialog with a date range picker. */
export function PeriodPicker({
  period,
  range,
  onPreset,
  onCustom,
}: {
  period: Period;
  range: DateRange;
  onPreset: (period: Exclude<Period, 'custom'>) => void;
  onCustom: (range: DateRange) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const options = PERIODS.map((item) =>
    item.id === 'custom' && period === 'custom' ? { ...item, label: `Custom · ${rangeLabel(range)}` } : item,
  );
  return (
    <div className="stats-period">
      {/* A Dropdown, not a combobox: a period is always chosen, so there is nothing to search or clear. */}
      <Dropdown
        id="stats-period"
        titleText="Period"
        label="Period"
        size="md"
        items={options}
        itemToString={(item) => item?.label ?? ''}
        selectedItem={options.find((item) => item.id === period) ?? null}
        onChange={({ selectedItem }) => {
          if (selectedItem?.id === 'custom') setDialogOpen(true);
          else if (selectedItem) onPreset(selectedItem.id as Exclude<Period, 'custom'>);
        }}
      />
      {period === 'custom' && (
        <IconButton kind="ghost" size="md" label="Change dates" align="bottom-end" onClick={() => setDialogOpen(true)}>
          <Calendar />
        </IconButton>
      )}
      {dialogOpen && (
        <CustomPeriodModal
          initial={range}
          onClose={() => setDialogOpen(false)}
          onApply={(next) => {
            setDialogOpen(false);
            onCustom(next);
          }}
        />
      )}
    </div>
  );
}
