import { InlineNotification } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Person, ProfileImage } from '../../../api/generated/models';
import { deletePersonProfileImage, getPutPersonProfileImageUrl } from '../../../api/generated/people/people';
import { apiFetch } from '../../../api/http-client';
import { authQueryKey, useCurrentUser } from '../../auth/auth';
import { refreshPersonData } from '../queries';
import { PersonAvatar } from '../PersonAvatar';
import { DetailSection } from '../PersonDetailComponents';
import { ProfilePictureEditor } from '../ProfilePictureEditor';

export function ProfileSection({
  person,
  canEditProfileImage,
  canUpdateProfileImage,
  canRemoveProfileImage,
}: {
  person: Person;
  canEditProfileImage: boolean;
  canUpdateProfileImage: boolean;
  canRemoveProfileImage: boolean;
}) {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const profileImageMutation = useMutation({
    mutationFn: (file: File) =>
      apiFetch<ProfileImage>(getPutPersonProfileImageUrl(person.id, { expectedVersion: person.version }), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': file.name,
          'X-Profile-Image-Source': currentUser.person.id === person.id ? 'self_upload' : 'admin_upload',
        },
        body: file,
      }),
    onSuccess: async () => {
      await refreshPersonData(queryClient, person.id);
      if (currentUser.person.id === person.id) {
        await queryClient.invalidateQueries({ queryKey: authQueryKey });
      }
    },
  });
  const removeProfileImageMutation = useMutation({
    mutationFn: () => deletePersonProfileImage(person.id, { expectedVersion: person.version }),
    onSuccess: async () => {
      await refreshPersonData(queryClient, person.id);
      if (currentUser.person.id === person.id) {
        await queryClient.invalidateQueries({ queryKey: authQueryKey });
      }
    },
  });

  return (
    <DetailSection
      title="Profile picture"
      className="person-profile-card"
      headingContent={
        <div className="person-profile-card__identity">
          <PersonAvatar
            firstName={person.firstName}
            lastName={person.lastName}
            profileImage={person.profileImage}
            size="lg"
          />
        </div>
      }
      action={
        canEditProfileImage ? (
          <ProfilePictureEditor
            id="person-profile-image"
            firstName={person.firstName}
            lastName={person.lastName}
            profileImage={person.profileImage}
            canUpdate={canUpdateProfileImage}
            canRemove={canRemoveProfileImage}
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
      {person.profileImageRequired && !person.profileImage && (
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
  );
}
