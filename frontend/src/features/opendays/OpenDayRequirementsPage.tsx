import { Button, Form, InlineNotification, NumberInput, Select, SelectItem, Stack, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { getOpenDayRequirements, updateOpenDayRequirements } from '../../api/generated/open-days/open-days';
import { ApiError } from '../../api/http-client';
import { SettingsLoading, SettingsPageLayout } from '../settings/SettingsPageLayout';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { fullRoleCatalogOptions } from '../roles/queries';
import { openDayKeys } from './queries';
import './styles.scss';

const requirementsKey = openDayKeys.requirements();

type FormValues = {
  minOpenDaysPerSemester: number | string;
  traineeOpenDaysForPromotion: number | string;
  supervisorRoleId: string;
};

const wholeNumber = (min: number, max: number) => (value: number | string) => {
  const number = typeof value === 'number' ? value : value.trim() === '' ? Number.NaN : Number(value);
  return (Number.isInteger(number) && number >= min && number <= max) || `Enter a whole number from ${min} to ${max}.`;
};

function saveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'Someone else changed these settings. Reload the page and try again.';
  }
  if (error instanceof ApiError && error.status === 422) {
    return 'Choose a role that is configured with the supervisor staffing level.';
  }
  return 'Check your connection and try again.';
}

/** Settings → Open day requirements. The minimums are configuration, never hard-coded. */
export function OpenDayRequirementsPage() {
  const client = useQueryClient();
  const currentUser = useCurrentUser();
  const canReadRoles = hasPermission(currentUser, PermissionId.rolesread);
  const requirements = useQuery({
    queryKey: requirementsKey,
    queryFn: ({ signal }) => getOpenDayRequirements({ signal }),
  });
  const roles = useQuery({ ...fullRoleCatalogOptions, enabled: canReadRoles });
  const supervisorRoles = (roles.data ?? []).filter((role) => role.staffingLevel === 'supervisor');

  const form = useForm<FormValues>({
    values: requirements.data
      ? {
          minOpenDaysPerSemester: requirements.data.minOpenDaysPerSemester,
          traineeOpenDaysForPromotion: requirements.data.traineeOpenDaysForPromotion,
          supervisorRoleId: requirements.data.supervisorRoleId ?? '',
        }
      : undefined,
    defaultValues: { minOpenDaysPerSemester: 2, traineeOpenDaysForPromotion: 3, supervisorRoleId: '' },
    mode: 'onChange',
  });
  const save = useMutation({
    mutationFn: (values: FormValues) =>
      updateOpenDayRequirements({
        minOpenDaysPerSemester: Number(values.minOpenDaysPerSemester),
        traineeOpenDaysForPromotion: Number(values.traineeOpenDaysForPromotion),
        supervisorRoleId: values.supervisorRoleId || null,
        expectedVersion: requirements.data!.version,
      }),
    onSuccess: async (updated) => {
      client.setQueryData(requirementsKey, updated);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['dashboard'] }),
        client.invalidateQueries({ queryKey: ['supervisor-dashboard'] }),
      ]);
    },
  });
  const submit = form.handleSubmit((values) => save.mutate(values));
  const { errors, isDirty } = form.formState;

  return (
    <SettingsPageLayout
      page="open-days"
      description="What every supervisor and trainee has to staff per semester. Used by the dashboard and the staffing page."
    >
      {requirements.isPending && <SettingsLoading label="Loading open day requirements" />}
      {requirements.isError && (
        <ErrorState
          title="Unable to load open day requirements"
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
                  title="Requirements not saved"
                  subtitle={saveErrorMessage(save.error)}
                />
              )}
              {save.isSuccess && !isDirty && (
                <InlineNotification
                  kind="success"
                  lowContrast
                  hideCloseButton
                  title="Requirements saved"
                  subtitle="The dashboard and the staffing page use them right away."
                />
              )}
              <Controller
                control={form.control}
                name="minOpenDaysPerSemester"
                rules={{ validate: wholeNumber(0, 20) }}
                render={({ field }) => (
                  <NumberInput
                    id="open-day-requirements-min"
                    label="Minimum open days per semester"
                    min={0}
                    max={20}
                    step={1}
                    allowEmpty
                    value={field.value}
                    helperText="Applies to supervisors and trainees. Supervisor and trainee places both count. 0 turns the minimum off. Roles can set their own minimum in the role settings; the lowest one wins for people with several roles."
                    invalid={Boolean(errors.minOpenDaysPerSemester)}
                    invalidText={errors.minOpenDaysPerSemester?.message}
                    onChange={(_event, { value }) => field.onChange(value)}
                  />
                )}
              />
              <Controller
                control={form.control}
                name="traineeOpenDaysForPromotion"
                rules={{ validate: wholeNumber(1, 20) }}
                render={({ field }) => (
                  <NumberInput
                    id="open-day-requirements-trainee"
                    label="Open days as trainee before becoming a supervisor"
                    min={1}
                    max={20}
                    step={1}
                    allowEmpty
                    value={field.value}
                    helperText="Only a hint: the staffing page marks trainees as ready. The Leitung still changes the role by hand."
                    invalid={Boolean(errors.traineeOpenDaysForPromotion)}
                    invalidText={errors.traineeOpenDaysForPromotion?.message}
                    onChange={(_event, { value }) => field.onChange(value)}
                  />
                )}
              />
              <Select
                id="open-day-requirements-role"
                labelText="Supervisor role for promotions"
                helperText={
                  canReadRoles
                    ? 'Trainees receive this role when the Leitung makes them a supervisor. Only roles with the supervisor staffing level are listed.'
                    : 'You need access to roles to change this role.'
                }
                disabled={!canReadRoles || roles.isPending}
                {...form.register('supervisorRoleId')}
              >
                <SelectItem value="" text="Not configured" />
                {requirements.data.supervisorRoleId &&
                  !supervisorRoles.some((role) => role.id === requirements.data.supervisorRoleId) && (
                    <SelectItem value={requirements.data.supervisorRoleId} text="Current supervisor role" />
                  )}
                {supervisorRoles.map((role) => (
                  <SelectItem key={role.id} value={role.id} text={role.name} />
                ))}
              </Select>
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Room access stays manual"
                subtitle="Missing the minimum only shows up on the dashboard and the staffing page; access is still changed in the access system."
              />
              <div>
                <Button type="submit" disabled={!isDirty || save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save requirements'}
                </Button>
              </div>
            </Stack>
          </Form>
        </Tile>
      )}
    </SettingsPageLayout>
  );
}
