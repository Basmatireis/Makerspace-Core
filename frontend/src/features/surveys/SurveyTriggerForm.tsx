import { Button, Form, InlineNotification, NumberInput, Stack, Toggle } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { updateSurveyTrigger } from '../../api/generated/surveys/surveys';
import type { Survey } from '../../api/generated/models';
import { maxCooldownDays, maxDelayMinutes } from './triggerFormat';

const defaultDelaySeconds = 1800;
const defaultCooldownDays = 30;

type TriggerValues = {
  enabled: boolean;
  delayMinutes: number | string;
  cooldownDays: number | string;
};

function validateRange(label: string, max: number, integer: boolean) {
  return (value: number | string) => {
    if (value === '' || value === undefined) return `${label} is required.`;
    const number = Number(value);
    if (!Number.isFinite(number)) return `${label} must be a number.`;
    if (number < 0 || number > max) return `${label} must be between 0 and ${max}.`;
    if (integer && !Number.isInteger(number)) return `${label} must be a whole number.`;
    return true;
  };
}

export function SurveyTriggerForm({ survey, onSaved }: { survey: Survey; onSaved: () => Promise<unknown> }) {
  const trigger = survey.trigger;
  const published = survey.status === 'published';
  const form = useForm<TriggerValues>({
    defaultValues: {
      enabled: trigger?.enabled ?? false,
      delayMinutes: Number(((trigger?.delaySeconds ?? defaultDelaySeconds) / 60).toFixed(2)),
      cooldownDays: trigger?.cooldownDays ?? defaultCooldownDays,
    },
  });
  const { control, handleSubmit, formState } = form;
  const save = useMutation({
    mutationFn: (values: TriggerValues) =>
      updateSurveyTrigger(survey.id, {
        enabled: values.enabled,
        delaySeconds: Math.round(Number(values.delayMinutes) * 60),
        cooldownDays: Number(values.cooldownDays),
        expectedVersion: trigger?.version ?? 0,
      }),
    onSuccess: onSaved,
  });
  return (
    <Form
      noValidate
      aria-label={`Post-visit trigger for ${survey.name}`}
      onSubmit={handleSubmit((values) => save.mutate(values))}
    >
      <Stack gap={5}>
        <h3>Post-visit trigger</h3>
        <Controller
          name="enabled"
          control={control}
          render={({ field }) => (
            <Toggle
              id={`trigger-enabled-${survey.id}`}
              labelText="Send after check-out"
              labelA="Disabled"
              labelB="Enabled"
              toggled={field.value}
              disabled={!published && !field.value}
              onToggle={field.onChange}
            />
          )}
        />
        {!published && <p className="cds--form__helper-text">Publish the survey to enable the trigger.</p>}
        <Controller
          name="delayMinutes"
          control={control}
          rules={{ validate: validateRange('Delay', maxDelayMinutes, false) }}
          render={({ field, fieldState }) => (
            <NumberInput
              id={`trigger-delay-${survey.id}`}
              label="Delay after check-out (minutes)"
              helperText="How long after check-out the invitation is sent"
              min={0}
              max={maxDelayMinutes}
              allowEmpty
              value={field.value}
              invalid={Boolean(fieldState.error)}
              invalidText={fieldState.error?.message}
              onChange={(_event, state) => field.onChange(state.value)}
            />
          )}
        />
        <Controller
          name="cooldownDays"
          control={control}
          rules={{ validate: validateRange('Cooldown', maxCooldownDays, true) }}
          render={({ field, fieldState }) => (
            <NumberInput
              id={`trigger-cooldown-${survey.id}`}
              label="Cooldown (days)"
              helperText="No new invitation to the same person within this many days"
              min={0}
              max={maxCooldownDays}
              allowEmpty
              value={field.value}
              invalid={Boolean(fieldState.error)}
              invalidText={fieldState.error?.message}
              onChange={(_event, state) => field.onChange(state.value)}
            />
          )}
        />
        {save.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Trigger not saved"
            subtitle={save.error.message}
          />
        )}
        <div>
          <Button type="submit" size="sm" disabled={save.isPending || !formState.isDirty}>
            Save trigger
          </Button>
        </div>
      </Stack>
    </Form>
  );
}
