import { useState } from 'react';
import {
  Button,
  Column,
  Form,
  Grid,
  InlineNotification,
  PasswordInput,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
  Tile,
} from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { PageHeader } from '../../app/PageHeader';
import { changeOwnPassword } from '../../api/generated/authentication/authentication';
import { updatePerson } from '../../api/generated/people/people';
import type { UpdatePersonRequest } from '../../api/generated/models';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { authQueryKey, useCurrentUser } from '../auth/auth';
import { validatePasswordLength } from '../auth/password-validation';
import {
  canUpdatePerson,
  hasPermission,
  PermissionId,
} from '../auth/permissions';
import { PersonFields, type PersonFormValues, toPersonPatch } from '../users/PersonForm';

type PasswordFormValues = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

export function ProfilePage() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const [editingProfile, setEditingProfile] = useState(false);
  const personForm = useForm<PersonFormValues>({
    defaultValues: {
      firstName: currentUser.person.firstName,
      lastName: currentUser.person.lastName,
      email: currentUser.person.email ?? '',
      phone: currentUser.person.phone ?? '',
      matriculationNumber: currentUser.person.matriculationNumber ?? '',
    },
  });
  const passwordForm = useForm<PasswordFormValues>({
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  const updateProfileMutation = useMutation({
    mutationFn: (request: UpdatePersonRequest) =>
      updatePerson(currentUser.person.id, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: authQueryKey });
      setEditingProfile(false);
    },
  });
  const passwordMutation = useSecretMutation(
    (request: Parameters<typeof changeOwnPassword>[0]) =>
      changeOwnPassword(request),
    { onSuccess: () => passwordForm.reset() },
  );

  const mayEdit = canUpdatePerson(currentUser, currentUser.person.id);
  const mayReadMatriculation = hasPermission(
    currentUser,
    PermissionId.peoplereadmatriculation,
  );
  const mayEditMatriculation =
    mayReadMatriculation &&
    hasPermission(currentUser, PermissionId.peopleupdatematriculation);

  const submitProfile = personForm.handleSubmit(async (values) => {
    const patch = toPersonPatch(
      values,
      personForm.formState.dirtyFields,
      currentUser.person.version,
      mayEditMatriculation,
    );
    try {
      await updateProfileMutation.mutateAsync(patch);
    } catch {
      // The mutation state renders the safe inline error.
    }
  });
  const submitPassword = passwordForm.handleSubmit(
    async ({ currentPassword, newPassword }) => {
      try {
        await passwordMutation.mutateAsync({ currentPassword, newPassword });
      } catch {
        // Session expiry is handled globally; other failures render below.
      }
    },
  );

  return (
    <Stack gap={8}>
      <PageHeader
        title="Profile"
        description="Review your personal information and account security."
        actions={
          mayEdit && !editingProfile ? (
            <Button renderIcon={Edit} onClick={() => setEditingProfile(true)}>
              Edit profile
            </Button>
          ) : undefined
        }
      />

      <Grid condensed>
        <Column sm={4} md={8} lg={8}>
          <Tile>
            <Stack gap={6}>
              <h2>Personal information</h2>
              {updateProfileMutation.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Profile not updated"
                  subtitle="Review the information and try again."
                />
              )}
              {editingProfile ? (
                <Form onSubmit={submitProfile}>
                  <Stack gap={6}>
                    <PersonFields
                      form={personForm}
                      showMatriculation={mayReadMatriculation}
                      editMatriculation={mayEditMatriculation}
                    />
                    <div className="form-actions">
                      <Button
                        type="button"
                        kind="secondary"
                        onClick={() => {
                          personForm.reset();
                          setEditingProfile(false);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        disabled={
                          !personForm.formState.isDirty ||
                          updateProfileMutation.isPending
                        }
                      >
                        {updateProfileMutation.isPending ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </Stack>
                </Form>
              ) : (
                <StructuredListWrapper isCondensed>
                  <StructuredListBody>
                    <StructuredListRow>
                      <StructuredListCell>Name</StructuredListCell>
                      <StructuredListCell>
                        {currentUser.person.firstName} {currentUser.person.lastName}
                      </StructuredListCell>
                    </StructuredListRow>
                    <StructuredListRow>
                      <StructuredListCell>Contact email</StructuredListCell>
                      <StructuredListCell>
                        {currentUser.person.email ?? 'Not provided'}
                      </StructuredListCell>
                    </StructuredListRow>
                    <StructuredListRow>
                      <StructuredListCell>Phone</StructuredListCell>
                      <StructuredListCell>
                        {currentUser.person.phone ?? 'Not provided'}
                      </StructuredListCell>
                    </StructuredListRow>
                    {mayReadMatriculation && (
                      <StructuredListRow>
                        <StructuredListCell>Matriculation number</StructuredListCell>
                        <StructuredListCell>
                          {currentUser.person.matriculationNumber ?? 'Not provided'}
                        </StructuredListCell>
                      </StructuredListRow>
                    )}
                  </StructuredListBody>
                </StructuredListWrapper>
              )}
            </Stack>
          </Tile>
        </Column>

        <Column sm={4} md={8} lg={8}>
          <Stack gap={6}>
            <Tile>
              <Stack gap={5}>
                <h2>Account</h2>
                <div className="account-summary">
                  <div>
                    <span className="label">Login email</span>
                    <span>{currentUser.account.loginEmail}</span>
                  </div>
                  <Tag
                    type={
                      currentUser.account.status === 'enabled' ? 'green' : 'gray'
                    }
                  >
                    {currentUser.account.status}
                  </Tag>
                </div>
                {currentUser.account.roles.length > 0 && (
                  <div className="tag-list" aria-label="Assigned roles">
                    {currentUser.account.roles.map((role) => (
                      <Tag key={role.id} type="blue">
                        {role.name}
                      </Tag>
                    ))}
                  </div>
                )}
              </Stack>
            </Tile>

            <Tile>
              <Form onSubmit={submitPassword}>
                <Stack gap={6}>
                  <div>
                    <h2>Change password</h2>
                    <p className="section-description">
                      Changing your password signs out your other sessions.
                    </p>
                  </div>
                  {passwordMutation.isSuccess && (
                    <InlineNotification
                      kind="success"
                      lowContrast
                      hideCloseButton
                      title="Password changed"
                      subtitle="Your other sessions have been signed out."
                    />
                  )}
                  {passwordMutation.isError && (
                    <InlineNotification
                      kind="error"
                      lowContrast
                      hideCloseButton
                      title="Password not changed"
                      subtitle="Check your current password and try again."
                    />
                  )}
                  <PasswordInput
                    id="profile-current-password"
                    autoComplete="current-password"
                    labelText="Current password"
                    invalid={Boolean(passwordForm.formState.errors.currentPassword)}
                    invalidText={
                      passwordForm.formState.errors.currentPassword?.message
                    }
                    {...passwordForm.register('currentPassword', {
                      required: 'Enter your current password.',
                    })}
                  />
                  <PasswordInput
                    id="profile-new-password"
                    autoComplete="new-password"
                    labelText="New password"
                    helperText="Use at least 12 characters."
                    invalid={Boolean(passwordForm.formState.errors.newPassword)}
                    invalidText={passwordForm.formState.errors.newPassword?.message}
                    {...passwordForm.register('newPassword', {
                      required: 'Enter a new password.',
                      validate: validatePasswordLength,
                    })}
                  />
                  <PasswordInput
                    id="profile-confirm-password"
                    autoComplete="new-password"
                    labelText="Confirm new password"
                    invalid={Boolean(passwordForm.formState.errors.confirmPassword)}
                    invalidText={
                      passwordForm.formState.errors.confirmPassword?.message
                    }
                    {...passwordForm.register('confirmPassword', {
                      required: 'Confirm the new password.',
                      validate: (value) =>
                        value === passwordForm.watch('newPassword') ||
                        'The passwords do not match.',
                    })}
                  />
                  <Button type="submit" disabled={passwordMutation.isPending}>
                    {passwordMutation.isPending ? 'Changing…' : 'Change password'}
                  </Button>
                </Stack>
              </Form>
            </Tile>
          </Stack>
        </Column>
      </Grid>
    </Stack>
  );
}
