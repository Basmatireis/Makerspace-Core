import { useEffect, useState } from 'react';
import {
  Button,
  ComposedModal,
  FileUploaderDropContainer,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  Tag,
} from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import type { Person } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { useLatestCallback } from '../../app/useLatestCallback';
import { PersonAvatar } from './PersonAvatar';
import { ProfilePhotoCropper } from './ProfilePhotoCropper';

type ProfilePictureEditorProps = {
  id: string;
  firstName: string;
  lastName: string;
  profileImage?: Person['profileImage'];
  canUpdate: boolean;
  canRemove: boolean;
  isUploading: boolean;
  isRemoving: boolean;
  removeError?: Error | null;
  trigger?: 'avatar' | 'button';
  onUpload: (file: File) => void;
  onRemove: () => void;
};

export function ProfilePictureEditor({
  id,
  firstName,
  lastName,
  profileImage,
  canUpdate,
  canRemove,
  isUploading,
  isRemoving,
  removeError,
  trigger = 'avatar',
  onUpload,
  onRemove,
}: ProfilePictureEditorProps) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Object URL of the chosen picture while it is positioned under the mask; revoked when it is dropped.
  const [chosen, setChosen] = useState<string>();
  const fullName = `${firstName} ${lastName}`;
  const canEdit = canUpdate || Boolean(profileImage && canRemove);
  const pending = isUploading || isRemoving;
  const closeEditor = useLatestCallback(() => {
    if (!pending) {
      setOpen(false);
      setChosen(undefined);
    }
    return false;
  });

  useEffect(() => {
    if (!chosen) return;
    return () => URL.revokeObjectURL(chosen);
  }, [chosen]);

  useEffect(() => {
    if (confirmRemove && !profileImage && !isRemoving) {
      setConfirmRemove(false);
      setOpen(false);
    }
  }, [confirmRemove, isRemoving, profileImage]);

  return (
    <>
      <div className="profile-picture-editor">
        {canEdit ? (
          trigger === 'button' ? (
            <Button kind="ghost" size="sm" renderIcon={Edit} disabled={pending} onClick={() => setOpen(true)}>
              Edit
            </Button>
          ) : (
            <Button
              kind="ghost"
              className="profile-picture-editor__trigger"
              aria-label={`Edit profile picture for ${fullName}`}
              disabled={pending}
              onClick={() => setOpen(true)}
            >
              <PersonAvatar
                firstName={firstName}
                lastName={lastName}
                profileImage={profileImage}
                size="lg"
                decorative
              />
              <Tag type="cool-gray" size="sm" className="profile-picture-editor__badge">
                Edit
              </Tag>
            </Button>
          )
        ) : trigger === 'avatar' ? (
          <PersonAvatar firstName={firstName} lastName={lastName} profileImage={profileImage} size="lg" />
        ) : null}
      </div>

      <ComposedModal open={open && !confirmRemove} aria-label="Edit profile picture" onClose={closeEditor} size="sm">
        <ModalHeader title="Edit profile picture" />
        <ModalBody>
          <Stack gap={6}>
            {chosen ? (
              <ProfilePhotoCropper
                src={chosen}
                confirmLabel="Save picture"
                cancelLabel="Choose another"
                busy={pending}
                onConfirm={(photo) => {
                  onUpload(new File([photo], 'profile-picture.jpg', { type: 'image/jpeg' }));
                  setChosen(undefined);
                  setOpen(false);
                }}
                onCancel={() => setChosen(undefined)}
              />
            ) : (
              <div className="profile-picture-editor__modal-preview">
                <PersonAvatar firstName={firstName} lastName={lastName} profileImage={profileImage} size="lg" />
              </div>
            )}
            {canUpdate && !chosen && (
              <FileUploaderDropContainer
                id={`${id}-upload`}
                accept={['image/jpeg', 'image/png', 'image/webp']}
                maxFileSize={8 << 20}
                multiple={false}
                disabled={pending}
                labelText={
                  isUploading ? 'Uploading…' : profileImage ? 'Choose a replacement picture' : 'Choose a picture'
                }
                onAddFiles={(_, { addedFiles }) => {
                  const file = addedFiles[0];
                  if (file) setChosen(URL.createObjectURL(file));
                }}
              />
            )}
            <p className="section-description">
              JPEG, PNG, or WebP up to 8 MiB. Images are normalized to a private JPEG and metadata is removed.
            </p>
            {profileImage && canRemove && !chosen && (
              <Button kind="danger--tertiary" size="sm" disabled={pending} onClick={() => setConfirmRemove(true)}>
                Remove picture
              </Button>
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={closeEditor}>
            Close
          </Button>
        </ModalFooter>
      </ComposedModal>

      <DestructiveActionDialog
        open={open && confirmRemove}
        title={`Remove profile picture for ${fullName}?`}
        confirmLabel="Remove picture"
        pending={isRemoving}
        error={removeError?.message}
        onClose={() => setConfirmRemove(false)}
        onConfirm={onRemove}
      >
        <p>The current profile picture will be permanently removed. A replacement can be uploaded later.</p>
      </DestructiveActionDialog>
    </>
  );
}
