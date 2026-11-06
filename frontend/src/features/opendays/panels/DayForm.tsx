import { useState } from 'react';
import { Button, InlineNotification, TextArea } from '@carbon/react';
import { Controller, useForm } from 'react-hook-form';
import type { CalendarEntry, EligibilityRole, OpenDay } from '../../../api/generated/models';
import { DateInput } from '../../../app/DateInput';
import { FormPanel } from './FormPanel';
import { NumberField, TimeslotEditor } from '../components/FormFields';
import { RoleMultiSelect } from '../RoleMultiSelect';
import { longDate, plural } from '../model/dates';
import { entriesOn } from '../model/seriesPlan';
import { dayError } from '../model/validate';
import type { DayValues } from '../model/workingCopy';

/**
 * Edit or add one open day in the working copy. The form keeps its values locally, so typing never re-renders the
 * page around it; Apply hands them to the working copy, and nothing reaches the server until the schedule is saved.
 */
export function DayForm({
  day,
  initial,
  period,
  otherDays,
  entries,
  roles,
  seriesName,
  assigned,
  notifies,
  onApply,
  onCancel,
  onEditSeries,
}: {
  /** The open day being edited; absent for a new one. */
  day?: OpenDay;
  initial: DayValues;
  period: { startsOn: string; endsOn: string };
  otherDays: readonly OpenDay[];
  entries: readonly CalendarEntry[];
  roles: readonly EligibilityRole[];
  /** Set when saving takes the day out of this series. */
  seriesName?: string;
  assigned: number;
  /** People get a message when their timeslot changes (any period but a draft). */
  notifies: boolean;
  onApply: (values: DayValues) => void;
  onCancel: () => void;
  onEditSeries?: () => void;
}) {
  const form = useForm<DayValues>({ defaultValues: initial });
  const [error, setError] = useState('');
  const date = form.watch('date');
  const slots = form.watch('slots');
  const context = date ? entriesOn(entries, date) : [];
  const submit = form.handleSubmit((values) => {
    const problem = dayError(values, period, otherDays, day?.id);
    setError(problem);
    if (!problem) onApply({ ...values, note: values.note.trim() });
  });
  return (
    <FormPanel
      title={day ? 'Edit this open day' : 'New open day'}
      meta={day ? longDate(initial.date) : undefined}
      secondary="Changes stay in the working copy until you save the schedule."
      formId="od-day-form"
      primaryLabel={day ? 'Apply' : 'Add open day'}
      onCancel={onCancel}
    >
      {seriesName && (
        <>
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Saving takes this day out of its series."
            subtitle={`It stops following ${seriesName}. To change every day of the series, edit the series instead.`}
          />
          {onEditSeries && (
            <div>
              <Button kind="ghost" size="sm" onClick={onEditSeries}>
                Edit series instead
              </Button>
            </div>
          )}
        </>
      )}
      <form id="od-day-form" className="od-form" noValidate onSubmit={(event) => void submit(event)}>
        <Controller
          control={form.control}
          name="date"
          render={({ field }) => (
            <DateInput
              id="od-day-date"
              labelText="Date"
              value={field.value}
              onChange={field.onChange}
              helperText={
                context.length
                  ? `${context.map((entry) => entry.name).join(', ')}: an open day is added anyway.`
                  : undefined
              }
            />
          )}
        />
        <Controller
          control={form.control}
          name="slots"
          render={({ field }) => <TimeslotEditor idPrefix="od-day" value={field.value} onChange={field.onChange} />}
        />
        <fieldset className="od-fs">
          <legend>Supervisor places{slots.length > 1 ? ' per timeslot' : ''}</legend>
          <Controller
            control={form.control}
            name="supervisorPlaces"
            render={({ field }) => (
              <NumberField id="od-day-sup" label="Places" value={field.value} onChange={field.onChange} />
            )}
          />
          <Controller
            control={form.control}
            name="supervisorRoleIds"
            render={({ field }) => (
              <RoleMultiSelect
                id="od-day-sup-roles"
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
          <legend>Trainee places{slots.length > 1 ? ' per timeslot' : ''}</legend>
          <Controller
            control={form.control}
            name="traineePlaces"
            render={({ field }) => (
              <NumberField id="od-day-tr" label="Places" value={field.value} onChange={field.onChange} />
            )}
          />
          <Controller
            control={form.control}
            name="traineeRoleIds"
            render={({ field }) => (
              <RoleMultiSelect
                id="od-day-tr-roles"
                titleText="Extra roles (any one suffices)"
                label="Any trainee"
                roles={[...roles]}
                selectedRoleIds={field.value}
                onChange={field.onChange}
              />
            )}
          />
        </fieldset>
        <p className="od-hint">
          Who is a supervisor or a trainee comes from their membership. Minimums and other rules are set under Staffing.
        </p>
        <TextArea
          id="od-day-note"
          labelText="Internal note"
          rows={3}
          placeholder="Only the Leitung sees this"
          {...form.register('note')}
        />
        {day && assigned > 0 && notifies && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title={`${plural(assigned, 'sign-up')} on this day.`}
            subtitle="People get a message when their timeslot changes or goes away."
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
