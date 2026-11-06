import { useState } from 'react';
import { InlineNotification } from '@carbon/react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import type { CalendarEntry, EligibilityRole } from '../../../api/generated/models';
import { DateInput } from '../../../app/DateInput';
import { ForcedDates, NumberField, TimeslotEditor } from '../components/FormFields';
import { RoleMultiSelect } from '../RoleMultiSelect';
import { dateOf, datesOnWeekday, dayMonth, plural, weekdayName } from '../model/dates';
import type { SeriesView } from '../model/derive';
import { entriesOn } from '../model/seriesPlan';
import type { SlotValue } from '../model/timeslots';
import { seriesError } from '../model/validate';
import type { SeriesValues } from '../model/workingCopy';
import type { OpenDay } from '../../../api/generated/models';
import { FormPanel } from './FormPanel';

type Fields = Omit<SeriesValues, 'slots'> & { slots: SlotValue[] };

/**
 * Edit a weekly series in the working copy: its timeslots, places and restrictions, how long it runs, and from which
 * date the changes apply to its days. Days edited on their own keep their settings.
 */
export function SeriesForm({
  series,
  initial,
  periodEndsOn,
  days,
  entries,
  roles,
  today,
  notifies,
  onApply,
  onCancel,
}: {
  series: SeriesView;
  initial: SeriesValues;
  periodEndsOn: string;
  /** The schedule as displayed, to count the days the changes reach. */
  days: readonly OpenDay[];
  entries: readonly CalendarEntry[];
  roles: readonly EligibilityRole[];
  today: string;
  notifies: boolean;
  onApply: (values: SeriesValues) => void;
  onCancel: () => void;
}) {
  const form = useForm<Fields>({ defaultValues: initial });
  const [error, setError] = useState('');
  const applyFrom = useWatch({ control: form.control, name: 'applyFrom' });
  const until = useWatch({ control: form.control, name: 'untilDate' });
  const mine = days.filter((day) => day.seriesId === series.id);
  const affected = mine.filter(
    (day) => day.status === 'scheduled' && dateOf(day.startsAt) >= applyFrom && new Date(day.endsAt) > new Date(today),
  );
  const separate = days.filter((day) => day.detachedFromSeriesId === series.id && !day.seriesId).length;
  const signed = affected.reduce(
    (sum, day) =>
      sum + day.timeslots.reduce((n, slot) => n + slot.requirements.reduce((m, item) => m + item.assignedCount, 0), 0),
    0,
  );
  const contextDates = datesOnWeekday(series.weekday, series.fromDate, until || series.untilDate).filter(
    (date) => entriesOn(entries, date).length > 0,
  );
  const submit = form.handleSubmit((values) => {
    const problem = seriesError({ ...values, periodEndsOn });
    setError(problem);
    if (!problem) onApply({ ...values, slots: values.slots.map(({ start, end }) => ({ start, end })) });
  });
  return (
    <FormPanel
      title={`Every ${weekdayName(series.weekday)}`}
      meta={series.pending ? 'New series' : 'Edit series'}
      secondary={`${dayMonth(series.fromDate)} – ${dayMonth(series.untilDate)} · ${plural(series.dayCount, 'open day')}`}
      formId="od-series-form"
      primaryLabel={series.pending ? 'Apply' : 'Apply to series'}
      onCancel={onCancel}
    >
      <form id="od-series-form" className="od-form" noValidate onSubmit={(event) => void submit(event)}>
        <Controller
          control={form.control}
          name="slots"
          render={({ field }) => <TimeslotEditor idPrefix="od-series" value={field.value} onChange={field.onChange} />}
        />
        <fieldset className="od-fs">
          <legend>Supervisor places per timeslot</legend>
          <Controller
            control={form.control}
            name="supervisorPlaces"
            render={({ field }) => (
              <NumberField id="od-series-sup" label="Places" value={field.value} onChange={field.onChange} />
            )}
          />
          <Controller
            control={form.control}
            name="supervisorRoleIds"
            render={({ field }) => (
              <RoleMultiSelect
                id="od-series-sup-roles"
                titleText="Extra roles (any one suffices)"
                label="Any supervisor"
                roles={[...roles]}
                selectedRoleIds={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </fieldset>
        <fieldset className="od-fs">
          <legend>Trainee places per timeslot</legend>
          <Controller
            control={form.control}
            name="traineePlaces"
            render={({ field }) => (
              <NumberField id="od-series-tr" label="Places" value={field.value} onChange={field.onChange} />
            )}
          />
          <Controller
            control={form.control}
            name="traineeRoleIds"
            render={({ field }) => (
              <RoleMultiSelect
                id="od-series-tr-roles"
                titleText="Extra roles (any one suffices)"
                label="Any trainee"
                roles={[...roles]}
                selectedRoleIds={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </fieldset>
        <div className="od-form__2">
          <Controller
            control={form.control}
            name="untilDate"
            render={({ field }) => (
              <DateInput id="od-series-until" labelText="Runs until" value={field.value} onChange={field.onChange} />
            )}
          />
          {!series.pending && (
            <Controller
              control={form.control}
              name="applyFrom"
              render={({ field }) => (
                <DateInput
                  id="od-series-from"
                  labelText="Apply changes from"
                  value={field.value}
                  onChange={field.onChange}
                />
              )}
            />
          )}
        </div>
        <Controller
          control={form.control}
          name="forcedDates"
          render={({ field }) => (
            <ForcedDates
              idPrefix="od-series"
              dates={contextDates}
              entries={entries}
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        {!series.pending && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title={`Changes ${plural(affected.length, 'upcoming open day')}.`}
            subtitle={`${separate ? `${plural(separate, 'day was', 'days were')} edited on ${separate === 1 ? 'its' : 'their'} own and keep${separate === 1 ? 's' : ''} their settings. ` : ''}Past and cancelled days stay as they are.${signed && notifies ? ` ${plural(signed, 'sign-up')} on these days; people get a message when their timeslot changes or goes away.` : ''}`}
          />
        )}
        {error && (
          <p className="od-field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </FormPanel>
  );
}
