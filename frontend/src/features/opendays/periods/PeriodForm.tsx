import { useState } from 'react';
import { InlineNotification, Select, SelectItem, TextInput } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { createOpenDayPeriod, updateOpenDayPeriod } from '../../../api/generated/open-days/open-days';
import type { OpenDayPeriod } from '../../../api/generated/models';
import { DateInput } from '../../../app/DateInput';
import { periodError, type PeriodFields as Fields } from '../model/periodDefaults';
import { scheduleErrorMessage } from '../scheduleErrors';
import { FormPanel } from '../panels/FormPanel';
import { openDayKeys } from '../queries';

/** Create a draft period (optionally with the series of an earlier one) or edit a period's name, dates and deadline. */
export function PeriodForm({
  period,
  initial,
  others,
  onDone,
  onCancel,
}: {
  period: OpenDayPeriod | null;
  initial: Fields;
  /** Earlier periods whose series can be copied. */
  others: OpenDayPeriod[];
  onDone: (period: OpenDayPeriod) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<Fields>({ defaultValues: initial });
  const [error, setError] = useState('');
  // Name and dates are fixed once staffing has started; only the sign-up deadline can change.
  const locked = period !== null && period.status !== 'draft';
  const mutation = useMutation({
    mutationFn: (values: Fields) =>
      period
        ? updateOpenDayPeriod(period.id, {
            name: values.name.trim(),
            startsOn: values.startsOn,
            endsOn: values.endsOn,
            signUpDeadline: values.signUpDeadline || null,
            expectedVersion: period.version,
          })
        : createOpenDayPeriod({
            name: values.name.trim(),
            startsOn: values.startsOn,
            endsOn: values.endsOn,
            signUpDeadline: values.signUpDeadline || null,
            ...(values.copySeriesFromPeriodId ? { copySeriesFromPeriodId: values.copySeriesFromPeriodId } : {}),
          }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: openDayKeys.all });
      onDone(saved);
    },
    onError: (failure) => setError(scheduleErrorMessage(failure)),
  });
  const submit = form.handleSubmit((values) => {
    const problem = periodError(values);
    setError(problem);
    if (!problem) mutation.mutate(values);
  });
  return (
    <FormPanel
      title={period ? `Edit ${period.name}` : 'New period'}
      meta="Open-day period"
      formId="od-period-form"
      primaryLabel={period ? 'Save' : 'Create period'}
      onCancel={onCancel}
      disabled={mutation.isPending}
    >
      {locked && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Name and dates are fixed once staffing has started."
          subtitle="Only the sign-up deadline can change."
        />
      )}
      <form id="od-period-form" className="od-form" noValidate onSubmit={(event) => void submit(event)}>
        <TextInput
          id="od-period-name"
          labelText="Name"
          placeholder="e.g. Summer semester 2027"
          readOnly={locked}
          {...form.register('name')}
        />
        <div className="od-form__2">
          <Controller
            control={form.control}
            name="startsOn"
            render={({ field }) => (
              <DateInput
                id="od-period-start"
                labelText="Starts on"
                value={field.value}
                onChange={field.onChange}
                readOnly={locked}
              />
            )}
          />
          <Controller
            control={form.control}
            name="endsOn"
            render={({ field }) => (
              <DateInput
                id="od-period-end"
                labelText="Ends on"
                value={field.value}
                onChange={field.onChange}
                readOnly={locked}
              />
            )}
          />
        </div>
        <Controller
          control={form.control}
          name="signUpDeadline"
          render={({ field }) => (
            <DateInput
              id="od-period-deadline"
              labelText="Sign-up deadline (optional)"
              helperText="Empty uses the default of the staffing rules."
              value={field.value}
              onChange={field.onChange}
            />
          )}
        />
        {!period && others.length > 0 && (
          <Controller
            control={form.control}
            name="copySeriesFromPeriodId"
            render={({ field }) => (
              <Select
                id="od-period-copy"
                labelText="Start with the series of"
                helperText="Copies weekday, timeslots and places; dates move into the new period and skip its holidays and breaks."
                value={field.value}
                onChange={(event) => field.onChange(event.target.value)}
              >
                <SelectItem value="" text="Nothing, start empty" />
                {others.map((other) => (
                  <SelectItem key={other.id} value={other.id} text={other.name} />
                ))}
              </Select>
            )}
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
