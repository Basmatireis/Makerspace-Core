import { Button, Form, InlineNotification, NumberInput, Stack, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { getStaffingRules, updateStaffingRules } from '../../api/generated/supervisors/supervisors';
import { ApiError } from '../../api/http-client';
import { SettingsLoading, SettingsPageLayout } from '../settings/SettingsPageLayout';
import { ErrorState } from '../../app/PageState';
import { openDayKeys } from './queries';
import './styles.scss';

const rulesKey = openDayKeys.requirements();

type FormValues = {
  supervisorMinimum: number | string;
  traineeMinimum: number | string;
  traineeReadyAfter: number | string;
  warningWindowDays: number | string;
};

const wholeNumber = (min: number, max: number) => (value: number | string) => {
  const number = typeof value === 'number' ? value : value.trim() === '' ? Number.NaN : Number(value);
  return (Number.isInteger(number) && number >= min && number <= max) || `Enter a whole number from ${min} to ${max}.`;
};

function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'Someone else changed these settings. Reload the page and try again.';
  }
  return 'Check your connection and try again.';
}

/** Settings → Open days & staffing: the staffing rules. The minimums are configuration, never hard-coded. */
export function OpenDayRequirementsPage() {
  const client = useQueryClient();
  const requirements = useQuery({
    queryKey: rulesKey,
    queryFn: ({ signal }) => getStaffingRules({ signal }),
  });

  const form = useForm<FormValues>({
    values: requirements.data
      ? {
          supervisorMinimum: requirements.data.supervisorMinimum,
          traineeMinimum: requirements.data.traineeMinimum,
          traineeReadyAfter: requirements.data.traineeReadyAfter,
          warningWindowDays: requirements.data.warningWindowDays,
        }
      : undefined,
    defaultValues: { supervisorMinimum: 2, traineeMinimum: 2, traineeReadyAfter: 3, warningWindowDays: 14 },
    mode: 'onChange',
  });
  const save = useMutation({
    mutationFn: (values: FormValues) => {
      const current = requirements.data!;
      // Count mode, default deadline and exceptions are kept as they are until the staffing page edits them.
      return updateStaffingRules({
        supervisorMinimum: Number(values.supervisorMinimum),
        traineeMinimum: Number(values.traineeMinimum),
        traineeReadyAfter: Number(values.traineeReadyAfter),
        warningWindowDays: Number(values.warningWindowDays),
        countBy: current.countBy,
        defaultDeadline: current.defaultDeadline,
        exceptions: current.exceptions.map(({ roleId, minimum }) => ({ roleId, minimum })),
        expectedVersion: current.version,
      });
    },
    onSuccess: async (updated) => {
      client.setQueryData(rulesKey, updated);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['dashboard'] }),
        client.invalidateQueries({ queryKey: ['supervisor-dashboard'] }),
      ]);
    },
  });
  const submit = form.handleSubmit((values) => save.mutate(values));
  const { errors, isDirty } = form.formState;
  const numberField = (name: keyof FormValues, label: string, min: number, max: number, helperText: string) => (
    <Controller
      control={form.control}
      name={name}
      rules={{ validate: wholeNumber(min, max) }}
      render={({ field }) => (
        <NumberInput
          id={`staffing-rules-${name}`}
          label={label}
          min={min}
          max={max}
          step={1}
          allowEmpty
          value={field.value}
          helperText={helperText}
          invalid={Boolean(errors[name])}
          invalidText={errors[name]?.message}
          onChange={(_event, { value }) => field.onChange(value)}
        />
      )}
    />
  );

  return (
    <SettingsPageLayout page="open-days">
      {requirements.isPending && <SettingsLoading label="Loading staffing rules" />}
      {requirements.isError && (
        <ErrorState
          title="Unable to load the staffing rules"
          message="Check your permission and connection."
          onRetry={() => void requirements.refetch()}
        />
      )}
      {requirements.data && (
        <Tile className="open-day-requirements">
          <Form onSubmit={submit} noValidate>
            <Stack gap={6}>
              {save.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Staffing rules not saved"
                  subtitle={saveErrorMessage(save.error)}
                />
              )}
              {save.isSuccess && !isDirty && (
                <InlineNotification
                  kind="success"
                  lowContrast
                  hideCloseButton
                  title="Staffing rules saved"
                  subtitle="The dashboard and the staffing page use them right away."
                />
              )}
              {numberField(
                'supervisorMinimum',
                'Minimum open days per semester for supervisors',
                0,
                20,
                'Supervisor and trainee places both count. 0 turns the minimum off.',
              )}
              {numberField(
                'traineeMinimum',
                'Minimum open days per semester for trainees',
                0,
                20,
                'Exceptions of extra roles can lower a minimum; an excusal frees a person for one semester.',
              )}
              {numberField(
                'traineeReadyAfter',
                'Open days as trainee before becoming a supervisor',
                1,
                20,
                'Only a hint: the staffing page marks trainees as ready. The membership is still changed by hand.',
              )}
              {numberField(
                'warningWindowDays',
                'Days ahead to point out open places',
                1,
                60,
                'The dashboard hint and the notification about a freed supervisor place look this far ahead.',
              )}
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Room access stays manual"
                subtitle="Missing the minimum only shows up on the dashboard and the staffing page; access is still changed in the access system."
              />
              <div>
                <Button type="submit" disabled={!isDirty || save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save staffing rules'}
                </Button>
              </div>
            </Stack>
          </Form>
        </Tile>
      )}
    </SettingsPageLayout>
  );
}
