import { NumberInput, RadioButton, RadioButtonGroup } from '@carbon/react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { DateTimeInput } from '../../../app/DateInput';
import { isZonedDateTimeValue } from '../../../app/dateTime';
import { formatDateTime } from '../shared/format';
import { runOutcomeChoices, useRunPreview, type RunValues } from './runFormHelpers';
import '../styles/jobs.scss';
import '../jobs/jobs.scss';

/** "Starts now" or "Already done"; a run that is already done asks for its start and outcome. */
export function RunWhenField({ idPrefix }: { idPrefix: string }) {
  const { control } = useFormContext<RunValues>();
  return (
    <Controller
      control={control}
      name="when"
      render={({ field }) => (
        <RadioButtonGroup
          name={`${idPrefix}-when`}
          legendText="When"
          orientation="horizontal"
          valueSelected={field.value}
          onChange={(value) => field.onChange(value)}
        >
          <RadioButton id={`${idPrefix}-when-now`} value="now" labelText="Starts now" />
          <RadioButton id={`${idPrefix}-when-past`} value="past" labelText="Already done" />
        </RadioButtonGroup>
      )}
    />
  );
}

/** Outcome of the run as a combobox; empty means not recorded yet. */
function OutcomeField({ idPrefix, helperText }: { idPrefix: string; helperText?: string }) {
  const { control } = useFormContext<RunValues>();
  return (
    <Controller
      control={control}
      name="outcome"
      render={({ field }) => (
        <FuzzySelectField
          id={`${idPrefix}-outcome`}
          titleText="Outcome"
          placeholder="Not recorded yet"
          helperText={helperText}
          options={runOutcomeChoices}
          value={field.value || null}
          onChange={(id) => field.onChange(id ?? '')}
        />
      )}
    />
  );
}

/**
 * Start, runtime and outcome of a manual run. With `withWhen` (new runs) the start and the outcome only show for a
 * run that is already done; otherwise (editing) the start always shows.
 */
export function RunTimingFields({
  idPrefix,
  withWhen = false,
  outcomeHelperText,
}: {
  idPrefix: string;
  withWhen?: boolean;
  outcomeHelperText?: string;
}) {
  const { control, formState } = useFormContext<RunValues>();
  const when = useWatch({ control, name: 'when' });
  const { end, inFuture } = useRunPreview();
  const past = !withWhen || when === 'past';
  return (
    <div className="jobs-run">
      {withWhen && <RunWhenField idPrefix={idPrefix} />}
      {past && (
        <Controller
          control={control}
          name="startsAt"
          rules={{
            validate: (value, all) => all.when === 'now' || isZonedDateTimeValue(value) || 'Enter a valid start time.',
          }}
          render={({ field }) => (
            <DateTimeInput
              id={`${idPrefix}-start`}
              labelText="Started at"
              value={field.value}
              onChange={field.onChange}
              required
            />
          )}
        />
      )}
      <div className="jobs-run__line">
        <Controller
          control={control}
          name="runtimeHours"
          rules={{ validate: (value, all) => (Number(value) || 0) * 60 + (Number(all.runtimeMinutes) || 0) > 0 }}
          render={({ field }) => (
            <NumberInput
              id={`${idPrefix}-runtime-hours`}
              label="Duration (h)"
              min={0}
              max={999}
              step={1}
              value={field.value}
              invalid={!!formState.errors.runtimeHours}
              invalidText="Duration must be longer than zero."
              onChange={(_event, { value }) => field.onChange(Number(value) || 0)}
            />
          )}
        />
        <Controller
          control={control}
          name="runtimeMinutes"
          render={({ field }) => (
            <NumberInput
              id={`${idPrefix}-runtime-minutes`}
              label="Duration (min)"
              min={0}
              max={59}
              step={1}
              value={field.value}
              onChange={(_event, { value }) => field.onChange(Number(value) || 0)}
            />
          )}
        />
        {past && !inFuture && <OutcomeField idPrefix={idPrefix} helperText={outcomeHelperText} />}
      </div>
      <p className="cds--form__helper-text">
        {end
          ? inFuture
            ? `Runs until ${formatDateTime(end)}; the outcome is recorded once it has ended, and it can be cancelled early.`
            : `Ended ${formatDateTime(end)}.`
          : 'Enter a start and a duration.'}
      </p>
    </div>
  );
}
