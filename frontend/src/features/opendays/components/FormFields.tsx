import { useState } from 'react';
import { Button, Checkbox, CheckboxGroup, IconButton, NumberInput, Select, SelectItem, TextInput } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { entriesOn } from '../model/seriesPlan';
import { shortDate } from '../model/dates';
import { nextSlot, splitByHours, splitIntoParts, type SlotValue } from '../model/timeslots';
import type { CalendarEntry } from '../../../api/generated/models';

/** A whole-number field; reports a number (or the minimum while the field is empty). */
export function NumberField({
  id,
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  helperText,
  invalidText,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  helperText?: string;
  invalidText?: string;
}) {
  return (
    <NumberInput
      id={id}
      label={label}
      value={value}
      min={min}
      max={max}
      step={1}
      allowEmpty
      helperText={helperText}
      invalid={Boolean(invalidText)}
      invalidText={invalidText}
      onChange={(_event, state) => {
        const next = Number(state.value);
        onChange(Number.isFinite(next) ? next : min);
      }}
    />
  );
}

/**
 * The timeslots of a day or series: start and end per row, add and remove, and "split the whole time" into hour slots or
 * equal slots. Controlled, so a parent form keeps the value local while the page around it does not re-render.
 */
export function TimeslotEditor({
  idPrefix,
  value,
  onChange,
  invalidText,
}: {
  idPrefix: string;
  value: SlotValue[];
  onChange: (value: SlotValue[]) => void;
  invalidText?: string;
}) {
  const [amount, setAmount] = useState(3);
  const [unit, setUnit] = useState<'hours' | 'parts'>('hours');
  const update = (index: number, patch: Partial<SlotValue>) =>
    onChange(value.map((slot, position) => (position === index ? { ...slot, ...patch } : slot)));
  const split = () => {
    if (!(amount > 0) || !value.length) return;
    const from = value[0].start;
    const to = value[value.length - 1].end;
    if (!from || !to) return;
    const parts = unit === 'parts' ? splitIntoParts(from, to, amount) : splitByHours(from, to, amount);
    if (!parts.length) return;
    // Keep each existing timeslot's identity (and with it its sign-ups) by position.
    onChange(parts.map((part, index) => ({ ...part, id: value[index]?.id })));
  };
  return (
    <fieldset className="od-slots">
      <legend>Timeslots</legend>
      {value.map((slot, index) => (
        <div key={index} className="od-slotrow">
          <TextInput
            id={`${idPrefix}-start-${index}`}
            type="time"
            step={900}
            labelText={`Timeslot ${index + 1} start`}
            hideLabel
            value={slot.start}
            onChange={(event) => update(index, { start: event.target.value })}
          />
          <span aria-hidden="true">–</span>
          <TextInput
            id={`${idPrefix}-end-${index}`}
            type="time"
            step={900}
            labelText={`Timeslot ${index + 1} end`}
            hideLabel
            value={slot.end}
            onChange={(event) => update(index, { end: event.target.value })}
          />
          {value.length > 1 ? (
            <IconButton
              kind="ghost"
              size="md"
              label={`Remove timeslot ${index + 1}`}
              onClick={() => onChange(value.filter((_, position) => position !== index))}
            >
              <TrashCan />
            </IconButton>
          ) : (
            <span />
          )}
        </div>
      ))}
      {invalidText && (
        <p className="od-field-error" role="alert">
          {invalidText}
        </p>
      )}
      <div className="od-slots__tools">
        <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => onChange([...value, nextSlot(value)])}>
          Add timeslot
        </Button>
        <span className="od-split">
          <NumberInput
            id={`${idPrefix}-split-amount`}
            label="Split the whole time into"
            size="sm"
            min={0.25}
            step={0.25}
            value={amount}
            allowEmpty
            onChange={(_event, state) => setAmount(Number(state.value))}
          />
          <Select
            id={`${idPrefix}-split-unit`}
            labelText="Split unit"
            hideLabel
            size="sm"
            value={unit}
            onChange={(event) => setUnit(event.target.value === 'parts' ? 'parts' : 'hours')}
          >
            <SelectItem value="hours" text="hour slots" />
            <SelectItem value="parts" text="equal slots" />
          </Select>
          <Button kind="ghost" size="sm" onClick={split}>
            Split
          </Button>
        </span>
      </div>
      <p className="od-hint">
        {value.length > 1
          ? 'People sign up per timeslot. Every timeslot gets the places below.'
          : 'Split a long day into timeslots so people can sign up for part of it.'}
      </p>
    </fieldset>
  );
}

/** Holiday and break dates of a series. They are skipped unless ticked. */
export function ForcedDates({
  idPrefix,
  dates,
  entries,
  value,
  onChange,
}: {
  idPrefix: string;
  dates: string[];
  entries: readonly CalendarEntry[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  if (!dates.length) return null;
  return (
    <CheckboxGroup legendText="Holidays and breaks are skipped. Tick a date to add an open day anyway.">
      {dates.map((date) => (
        <Checkbox
          key={date}
          id={`${idPrefix}-force-${date}`}
          labelText={`${shortDate(date)} · ${entriesOn(entries, date)[0]?.name ?? ''}`}
          checked={value.includes(date)}
          onChange={(_event, { checked }) =>
            onChange(checked ? [...value, date].sort() : value.filter((item) => item !== date))
          }
        />
      ))}
    </CheckboxGroup>
  );
}
