import { useState } from 'react';
import {
  Button,
  Column,
  CopyButton,
  Form,
  Grid,
  InlineNotification,
  Stack,
  StructuredListBody,
  StructuredListWrapper,
  Tag,
} from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { PageShell } from '../../app/PageShell';
import { formatDate, formatDateTime } from '../../app/dateTime';
import { updatePerson } from '../../api/generated/people/people';
import { deletePersonProfileImage, getPutPersonProfileImageUrl } from '../../api/generated/people/people';
import type { ProfileImage, UpdatePersonRequest } from '../../api/generated/models';
import { apiFetch } from '../../api/http-client';
import { authQueryKey, useCurrentUser } from '../auth/auth';
import { canUpdatePerson, hasPermission, PermissionId } from '../auth/permissions';
import { PersonFields, type PersonFormValues, toPersonPatch } from '../users/PersonForm';
import { DetailRow, DetailSection } from '../users/PersonDetailComponents';
import { PersonAvatar } from '../users/PersonAvatar';
import { ProfilePictureEditor } from '../users/ProfilePictureEditor';
import { canReadTrainingRecords } from '../trainings/queries';
import { TrainingRecordsSection } from '../trainings/TrainingRecordsSection';
import { AuthenticationDialogs } from './AuthenticationDialogs';
import { AuthenticationMethodsSection } from './AuthenticationMethodsSection';
import { useProfileAuthentication } from './useProfileAuthentication';

export function ProfilePage() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const authentication = useProfileAuthentication();
  const [editingProfile, setEditingProfile] = useState(false);
  const personForm = useForm<PersonFormValues>({
    defaultValues: {
      firstName: currentUser.person.firstName,
      lastName: currentUser.person.lastName,
      email: currentUser.person.email ?? '',
      phone: currentUser.person.phone ?? '',
      matriculationNumber: currentUser.person.matriculationNumber ?? '',
      memberSince: currentUser.person.memberSince,
    },
  });
  const updateProfileMutation = useMutation({
    mutationFn: (request: UpdatePersonRequest) => updatePerson(currentUser.person.id, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: authQueryKey });
      setEditingProfile(false);
    },
  });
  const profileImageMutation = useMutation({
    mutationFn: (file: File) =>
      apiFetch<ProfileImage>(
        getPutPersonProfileImageUrl(currentUser.person.id, { expectedVersion: currentUser.person.version }),
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-File-Name': file.name,
            'X-Profile-Image-Source': 'self_upload',
          },
          body: file,
        },
      ),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: authQueryKey }),
  });
  const removeProfileImageMutation = useMutation({
    mutationFn: () => deletePersonProfileImage(currentUser.person.id, { expectedVersion: currentUser.person.version }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: authQueryKey }),
  });

  const mayEdit = canUpdatePerson(currentUser, currentUser.person.id);
  const mayReadMatriculation = hasPermission(currentUser, PermissionId.peoplereadmatriculation);
  const mayEditMatriculation =
    mayReadMatriculation && hasPermission(currentUser, PermissionId.peopleupdatematriculation);
  const mayUpdateProfileImage = hasPermission(currentUser, PermissionId.peopleprofile_imageupdateself);
  const mayRemoveProfileImage = hasPermission(currentUser, PermissionId.peopleprofile_imageremoveself);

  const submitProfile = personForm.handleSubmit(async (values) => {
    const patch = toPersonPatch(
      values,
      personForm.formState.dirtyFields,
      currentUser.person.version,
      mayEditMatriculation,
      { includeEmail: false },
    );
    try {
      await updateProfileMutation.mutateAsync(patch);
    } catch {
      // The mutation state renders the safe inline error.
    }
  });

  return (
    <PageShell
      title="Profile"
      description="Review your personal information and account security."
      className="person-detail-page"
    >
      <div className="person-detail-layout">
        <Grid className="person-detail-grid person-detail-grid--overview">
          <Column sm={4} md={3} lg={6} className="person-detail-grid__stretch-cell">
            <DetailSection
              title="Profile picture"
              className="person-profile-card"
              headingContent={
                <div className="person-profile-card__identity">
                  <PersonAvatar
                    firstName={currentUser.person.firstName}
                    lastName={currentUser.person.lastName}
                    profileImage={currentUser.person.profileImage}
                    size="lg"
                  />
                </div>
              }
              action={
                mayUpdateProfileImage || (currentUser.person.profileImage && mayRemoveProfileImage) ? (
                  <ProfilePictureEditor
                    id="own-profile-image"
                    firstName={currentUser.person.firstName}
                    lastName={currentUser.person.lastName}
                    profileImage={currentUser.person.profileImage}
                    canUpdate={mayUpdateProfileImage}
                    canRemove={mayRemoveProfileImage}
                    isUploading={profileImageMutation.isPending}
                    isRemoving={removeProfileImageMutation.isPending}
                    removeError={removeProfileImageMutation.error}
                    trigger="button"
                    onUpload={(file) => profileImageMutation.mutate(file)}
                    onRemove={() => removeProfileImageMutation.mutate()}
                  />
                ) : undefined
              }
            >
              {currentUser.person.profileImageRequired && !currentUser.person.profileImage && (
                <InlineNotification
                  kind="warning"
                  lowContrast
                  hideCloseButton
                  title="Profile picture required"
                  subtitle="At least one assigned role requires a profile picture."
                />
              )}
              {profileImageMutation.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Picture not updated"
                  subtitle="Use a JPEG, PNG, or WebP image up to 8 MiB and 4096×4096 pixels."
                />
              )}
            </DetailSection>
          </Column>

          <Column sm={4} md={5} lg={10} className="person-detail-grid__stretch-cell">
            <DetailSection
              title="Account access"
              meta={
                <Tag type={currentUser.account.status === 'enabled' ? 'green' : 'gray'}>
                  {currentUser.account.status === 'enabled' ? 'Active' : 'Inactive'}
                </Tag>
              }
            >
              <StructuredListWrapper isCondensed>
                <StructuredListBody>
                  <DetailRow
                    label="Account status"
                    value={currentUser.account.status === 'enabled' ? 'Active' : 'Inactive'}
                  />
                  <DetailRow
                    label="Provisioning source"
                    value={formatProvisioningSource(currentUser.account.provisioningSource)}
                  />
                  <DetailRow
                    label="First sign-in"
                    value={
                      currentUser.account.firstAuthenticatedAt
                        ? formatDateTime(currentUser.account.firstAuthenticatedAt)
                        : 'Not yet'
                    }
                  />
                  <DetailRow
                    label="Account ID"
                    value={currentUser.account.id}
                    monospace
                    action={
                      <CopyButton
                        size="sm"
                        iconDescription="Copy account ID"
                        feedback="Account ID copied"
                        onClick={() => void navigator.clipboard.writeText(currentUser.account.id)}
                      />
                    }
                  />
                </StructuredListBody>
              </StructuredListWrapper>
            </DetailSection>
          </Column>

          <Column sm={4} md={3} lg={6} className="person-detail-grid__stretch-cell">
            <DetailSection
              title="Personal information"
              action={
                mayEdit && !editingProfile ? (
                  <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setEditingProfile(true)}>
                    Edit
                  </Button>
                ) : undefined
              }
            >
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
                      hasAccount
                      emailLocked
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
                      <Button type="submit" disabled={!personForm.formState.isDirty || updateProfileMutation.isPending}>
                        {updateProfileMutation.isPending ? 'Saving…' : 'Save'}
                      </Button>
                    </div>
                  </Stack>
                </Form>
              ) : (
                <StructuredListWrapper isCondensed>
                  <StructuredListBody>
                    <DetailRow label="First name" value={currentUser.person.firstName} />
                    <DetailRow label="Last name" value={currentUser.person.lastName} />
                    <DetailRow label="Email" value={currentUser.person.email ?? 'Not provided'} />
                    <DetailRow label="Phone" value={currentUser.person.phone ?? 'Not provided'} />
                    <DetailRow label="Member since" value={formatDate(currentUser.person.memberSince)} />
                    {mayReadMatriculation && (
                      <DetailRow
                        label="Matriculation number"
                        value={currentUser.person.matriculationNumber ?? 'Not provided'}
                      />
                    )}
                  </StructuredListBody>
                </StructuredListWrapper>
              )}
            </DetailSection>
          </Column>

          <Column sm={4} md={5} lg={10} className="person-detail-overview__stack">
            <Stack gap={6}>
              <AuthenticationMethodsSection authentication={authentication} />

              <DetailSection
                title="Roles"
                meta={<span className="section-description">{currentUser.person.roles.length} assigned</span>}
              >
                <div className="tag-list" aria-label="Assigned roles">
                  {currentUser.person.roles.length === 0 && <span>No roles assigned</span>}
                  {currentUser.person.roles.map((role) => (
                    <Tag key={role.id} type={role.systemKey === 'master' ? 'purple' : 'blue'}>
                      {role.name}
                    </Tag>
                  ))}
                </div>
              </DetailSection>
              {canReadTrainingRecords(currentUser, currentUser.person.id) && (
                <TrainingRecordsSection personId={currentUser.person.id} own />
              )}
            </Stack>
          </Column>
        </Grid>
      </div>

      <AuthenticationDialogs authentication={authentication} />
    </PageShell>
  );
}

function formatProvisioningSource(source: string): string {
  return source.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}
