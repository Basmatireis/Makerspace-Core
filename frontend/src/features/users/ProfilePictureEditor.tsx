import { useState } from 'react';
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
import type { Person } from '../../api/generated/models';
import { PersonAvatar } from './PersonAvatar';

type ProfilePictureEditorProps = {
  id: string;
  firstName: string;
  lastName: string;
  profileImage?: Person['profileImage'];
  canUpdate: boolean;
  canRemove: boolean;
  isUploading: boolean;
  isRemoving: boolean;
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
  onUpload,
  onRemove,
}: ProfilePictureEditorProps) {
  const [open, setOpen] = useState(false);
  const fullName = `${firstName} ${lastName}`;
  const canEdit = canUpdate || Boolean(profileImage && canRemove);
  const pending = isUploading || isRemoving;

  return (
    <>
      <div className="profile-picture-editor">
        {canEdit ? (
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
        ) : (
          <PersonAvatar
            firstName={firstName}
            lastName={lastName}
            profileImage={profileImage}
            size="lg"
          />
        )}
      </div>

      <ComposedModal
        open={open}
        aria-label="Edit profile picture"
        onClose={() => !pending && setOpen(false)}
        size="sm"
      >
        <ModalHeader title="Edit profile picture" />
        <ModalBody>
          <Stack gap={6}>
            <div className="profile-picture-editor__modal-preview">
              <PersonAvatar
                firstName={firstName}
                lastName={lastName}
                profileImage={profileImage}
                size="lg"
              />
            </div>
            {canUpdate && (
              <FileUploaderDropContainer
                id={`${id}-upload`}
                accept={['image/jpeg', 'image/png', 'image/webp']}
                maxFileSize={8 << 20}
                multiple={false}
                disabled={pending}
                labelText={isUploading ? 'Uploading…' : profileImage ? 'Choose a replacement picture' : 'Choose a picture'}
                onAddFiles={(_, { addedFiles }) => {
                  const file = addedFiles[0];
                  if (!file) return;
                  onUpload(file);
                  setOpen(false);
                }}
              />
            )}
            <p className="section-description">
              JPEG, PNG, or WebP up to 8 MiB. Images are normalized to a private JPEG and metadata is removed.
            </p>
            {profileImage && canRemove && (
              <Button
                kind="danger--tertiary"
                size="sm"
                disabled={pending}
                onClick={() => {
                  onRemove();
                  setOpen(false);
                }}
              >
                {isRemoving ? 'Removing…' : 'Remove picture'}
              </Button>
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={pending} onClick={() => setOpen(false)}>
            Close
          </Button>
        </ModalFooter>
      </ComposedModal>
    </>
  );
}
