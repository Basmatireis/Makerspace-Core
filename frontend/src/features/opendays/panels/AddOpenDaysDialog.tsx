import { useState } from 'react';
import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Select, SelectItem } from '@carbon/react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import type { CalendarEntry, OpenDay } from '../../../api/generated/models';
import { DateInput } from '../../../app/DateInput';
import { ForcedDates, NumberField, TimeslotEditor } from '../components/FormFields';
import { clockOf, dateOf, datesOnWeekday, dayMonth, plural, shortDate, WEEKDAY_NAMES } from '../model/dates';
import { entriesOn, planSeries } from '../model/seriesPlan';
import { overallRange, slotsError, type SlotValue } from '../model/timeslots';
import { dayError, seriesError } from '../model/validate';
import type { DayValues, SeriesValues } from '../model/workingCopy';

type Fields = {
  mode: 'weekly' | 'single';
  weekday: string;
  from: string;
  until: string;
  slots: SlotValue[];
  supervisorPlaces: number;
  traineePlaces: number;
  forced: string[];
};

/** Add open days to the working copy: a weekly series, or a single day. Holidays and breaks are skipped unless ticked. */
export function AddOpenDaysDialog({
  period,
  days,
  entries,
  today,
  onClose,
  onAddSeries,
  onAddDay,
}: {
  period: { name: string; startsOn: string; endsOn: string };
  days: readonly OpenDay[];
  entries: readonly CalendarEntry[];
  today: string;
  onClose: () => void;
  onAddSeries: (values: SeriesValues) => void;
  onAddDay: (values: DayValues) => void;
}) {
  const form = useForm<Fields>({
    defaultValues: {
      mode: 'weekly',
      weekday: '2',
      from: today > period.startsOn ? today : period.startsOn,
      until: period.endsOn,
      slots: [{ start: '17:00', end: '21:00' }],
      supervisorPlaces: 2,
      traineePlaces: 1,
      forced: [],
    },
  });
  const [error, setError] = useState('');
  const values = useWatch({ control: form.control });
  const mode = values.mode ?? 'weekly';
  const slots = (values.slots ?? []).map((slot) => ({ start: slot?.start ?? '', end: slot?.end ?? '' }));
  const weekly = mode === 'weekly';
  const occupied = (date: string) =>
    days
      .filter((day) => day.status === 'scheduled' && dateOf(day.startsAt) === date)
      .map((day) => overallRange([{ start: clockOf(day.startsAt), end: clockOf(day.endsAt) }]));
  const problem = slotsError(slots);
  const plan =
    weekly && !problem && values.from && values.until
      ? planSeries({
          weekday: Number(values.weekday),
          from: values.from,
          until: values.until,
          slots,
          forced: values.forced ?? [],
          entries,
          occupied,
        })
      : null;
  const contextDates =
    weekly && values.from && values.until
      ? datesOnWeekday(Number(values.weekday), values.from, values.until).filter(
          (date) => entriesOn(entries, date).length > 0 && !plan?.conflicts.includes(date),
        )
      : [];
  const singleContext = !weekly && values.from ? entriesOn(entries, values.from) : [];
  const submit = form.handleSubmit((v) => {
    if (weekly) {
      const message = seriesError({
        slots: v.slots,
        fromDate: v.from,
        untilDate: v.until,
        periodEndsOn: period.endsOn,
        supervisorPlaces: v.supervisorPlaces,
        traineePlaces: v.traineePlaces,
      });
      const outside = v.from < period.startsOn ? 'The series must start within the period.' : '';
      setError(message || outside || (plan && !plan.make.length ? 'No date is left for an open day.' : ''));
      if (message || outside || (plan && !plan.make.length)) return;
      onAddSeries({
        weekday: Number(v.weekday),
        fromDate: v.from,
        untilDate: v.until,
        applyFrom: v.from,
        slots: v.slots.map(({ start, end }) => ({ start, end })),
        supervisorPlaces: v.supervisorPlaces,
        traineePlaces: v.traineePlaces,
        supervisorRoleIds: [],
        traineeRoleIds: [],
        forcedDates: v.forced,
      });
      return;
    }
    const day: DayValues = {
      date: v.from,
      slots: v.slots,
      supervisorPlaces: v.supervisorPlaces,
      traineePlaces: v.traineePlaces,
      supervisorRoleIds: [],
      traineeRoleIds: [],
      note: '',
    };
    const message = dayError(day, period, days);
    setError(message);
    if (!message) onAddDay(day);
  });
  const primary = weekly ? `Add series of ${plural(plan?.make.length ?? 0, 'open day')}` : 'Add open day';
  return (
    <Modal
      open
      size="md"
      modalHeading="Add open days"
      modalLabel={period.name}
      primaryButtonText={primary}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={weekly && Boolean(problem)}
      onRequestClose={onClose}
      onRequestSubmit={() => void submit()}
    >
      <form className="od-form" noValidate onSubmit={(event) => void submit(event)}>
        <Controller
          control={form.control}
          name="mode"
          render={({ field }) => (
            <RadioButtonGroup
              legendText="Repeat"
              name="od-add-mode"
              valueSelected={field.value}
              onChange={(value) => field.onChange(value)}
            >
              <RadioButton id="od-add-weekly" labelText="Every week (series)" value="weekly" />
              <RadioButton id="od-add-single" labelText="One day only" value="single" />
            </RadioButtonGroup>
          )}
        />
        {weekly && (
          <Controller
            control={form.control}
            name="weekday"
            render={({ field }) => (
              <Select
                id="od-add-weekday"
                labelText="Weekday"
                value={field.value}
                onChange={(event) => field.onChange(event.target.value)}
              >
                {WEEKDAY_NAMES.map((name, index) => (
                  <SelectItem key={name} value={String(index + 1)} text={name} />
                ))}
              </Select>
            )}
          />
        )}
        <div className="od-form__2">
          <Controller
            control={form.control}
            name="from"
            render={({ field }) => (
              <DateInput
                id="od-add-from"
                labelText={weekly ? 'From' : 'Date'}
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
          {weekly && (
            <Controller
              control={form.control}
              name="until"
              render={({ field }) => (
                <DateInput id="od-add-until" labelText="Until" value={field.value} onChange={field.onChange} />
              )}
            />
          )}
        </div>
        <Controller
          control={form.control}
          name="slots"
          render={({ field }) => <TimeslotEditor idPrefix="od-add" value={field.value} onChange={field.onChange} />}
        />
        <div className="od-form__2">
          <Controller
            control={form.control}
            name="supervisorPlaces"
            render={({ field }) => (
              <NumberField
                id="od-add-sup"
                label="Supervisor places per timeslot"
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={form.control}
            name="traineePlaces"
            render={({ field }) => (
              <NumberField
                id="od-add-tr"
                label="Trainee places per timeslot"
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </div>
        {problem ? (
          <InlineNotification kind="error" lowContrast hideCloseButton title={problem} />
        ) : weekly && plan ? (
          <InlineNotification
            kind={plan.make.length ? 'info' : 'warning'}
            lowContrast
            hideCloseButton
            title={`A series of ${plural(plan.make.length, 'open day')}${slots.length > 1 ? `, each with ${slots.length} timeslots` : ''}.`}
            subtitle={`Edit them together later with Edit series; a day you edit on its own leaves the series.${
              plan.conflicts.length
                ? ` Not possible on ${plan.conflicts.map(dayMonth).join(', ')}: another open day already overlaps.`
                : ''
            }`}
          />
        ) : null}
        {singleContext.length > 0 && (
          <p className="od-hint">
            {shortDate(values.from ?? '')} is {singleContext[0].name}. The open day is added anyway.
          </p>
        )}
        {weekly && (
          <Controller
            control={form.control}
            name="forced"
            render={({ field }) => (
              <ForcedDates
                idPrefix="od-add"
                dates={contextDates}
                entries={entries}
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
        )}
        {error && (
          <p className="od-field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}
