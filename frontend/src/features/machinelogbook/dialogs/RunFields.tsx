import { FormGroup, NumberInput, Select, SelectItem } from '@carbon/react';
import { Controller, useFormContext } from 'react-hook-form';
import { DateTimeInput } from '../../../app/DateInput';
import { isZonedDateTimeValue } from '../../../app/dateTime';
import { formatDateTime } from '../shared/format';
import { runOutcomeChoices, useRunPreview, type RunValues } from './runFormHelpers';
import '../styles/jobs.scss';

export function RunTimingFields({ idPrefix }: { idPrefix: string }) {
  const { control, formState } = useFormContext<RunValues>();
  const { end, inFuture } = useRunPreview();
  return (
    <div className="mj-form-grid">
      <Controller control={control} name="startsAt" rules={{ validate: (value) => isZonedDateTimeValue(value) || 'Enter a valid start time.' }} render={({ field }) => <DateTimeInput id={`${idPrefix}-start`} labelText="Start" value={field.value} onChange={field.onChange} required />} />
      <FormGroup legendText="Runtime" className="mj-runtime">
        <div className="mj-runtime__fields">
          <Controller
            control={control} name="runtimeHours"
            rules={{ validate: (value, all) => (Number(value) || 0) * 60 + (Number(all.runtimeMinutes) || 0) > 0 }}
            render={({ field }) => <NumberInput id={`${idPrefix}-runtime-hours`} label="Hours" min={0} max={999} step={1} value={field.value} invalid={!!formState.errors.runtimeHours} invalidText="Runtime must be longer than zero." onChange={(_event, { value }) => field.onChange(Number(value) || 0)} />}
          />
          <Controller
            control={control} name="runtimeMinutes"
            render={({ field }) => <NumberInput id={`${idPrefix}-runtime-minutes`} label="Minutes" min={0} max={59} step={1} value={field.value} onChange={(_event, { value }) => field.onChange(Number(value) || 0)} />}
          />
        </div>
        <p className="cds--form__helper-text">{end ? `Ends ${formatDateTime(end)}` : 'Enter a start and a runtime.'}</p>
        {inFuture && <p className="cds--form__helper-text">The end is in the future, so the run shows as running until then and can be cancelled early. The outcome is recorded once it has ended.</p>}
      </FormGroup>
    </div>
  );
}

/** Outcome of the run; hidden while the run has not ended. Empty means not recorded yet. */
export function RunOutcomeField({ idPrefix, helperText }: { idPrefix: string; helperText?: string }) {
  const { register } = useFormContext<RunValues>();
  const { inFuture } = useRunPreview();
  if (inFuture) return null;
  return (
    <Select id={`${idPrefix}-outcome`} labelText="Outcome" helperText={helperText} {...register('outcome')}>
      <SelectItem value="" text="Not recorded yet" />
      {runOutcomeChoices.map((option) => <SelectItem key={option.id} value={option.id} text={option.label} />)}
    </Select>
  );
}
