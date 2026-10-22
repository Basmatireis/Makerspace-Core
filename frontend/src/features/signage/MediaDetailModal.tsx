import { useState } from 'react';
import {
  Button,
  CodeSnippet,
  InlineNotification,
  Link as CarbonLink,
  Modal,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  TextInput,
} from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { SignageAsset, SignageScene } from '../../api/generated/models';
import { deleteSignageAsset, renameSignageAsset } from '../../api/generated/signage/signage';
import { DeleteDialog } from './components';
import { errorMessage, fontCss, formatBytes, formatDateTime, formatDuration } from './helpers';
import { FontSample } from './FontSample';
import { assetContentUrl } from './preview';
import { signageKeys } from './queries';
import { signagePaths } from './paths';

export function MediaDetailModal({
  asset,
  usedIn,
  canEdit,
  onClose,
}: {
  asset: SignageAsset;
  usedIn: SignageScene[];
  canEdit: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(asset.name);
  const [deleting, setDeleting] = useState(false);
  const rename = useMutation({
    mutationFn: () => renameSignageAsset(asset.id, { name: name.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.assets() });
    },
  });
  const row = (label: string, value: React.ReactNode) => (
    <StructuredListRow>
      <StructuredListCell noWrap>{label}</StructuredListCell>
      <StructuredListCell>{value}</StructuredListCell>
    </StructuredListRow>
  );
  const url = assetContentUrl(asset.id, asset.sha256);
  const renamed = name.trim() !== asset.name;

  if (deleting) {
    return (
      <DeleteDialog
        title={`Delete “${asset.name}”?`}
        noun="Media"
        confirmLabel="Delete media"
        remove={() => deleteSignageAsset(asset.id)}
        onDeleted={onClose}
        onClose={() => setDeleting(false)}
      >
        <p>The file is removed from storage. Media that a scene still uses cannot be deleted.</p>
      </DeleteDialog>
    );
  }

  return (
    <Modal
      open
      size="md"
      passiveModal
      modalHeading={asset.name}
      modalLabel={asset.kind === 'image' ? 'Image' : asset.kind === 'font' ? 'Font' : 'Video'}
      onRequestClose={onClose}
    >
      <div className="sg-media-detail">
        {asset.kind === 'image' ? (
          <img className="sg-media-detail__image" src={url} alt="" />
        ) : asset.kind === 'font' ? (
          <div className="sg-font-detail">
            <FontSample
              asset={asset}
              text="The quick brown fox jumps over the lazy dog"
              className="sg-font-detail__sample"
            />
            <FontSample asset={asset} text="ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789" />
          </div>
        ) : (
          <video className="sg-media-detail__image" src={url} controls muted preload="metadata" />
        )}
        <StructuredListWrapper isCondensed aria-label="Media details">
          <StructuredListBody>
            {asset.kind !== 'font' &&
              row('Dimensions', asset.width && asset.height ? `${asset.width} × ${asset.height}` : 'Unknown')}
            {asset.kind === 'font' &&
              row(
                'Use in CSS',
                <CodeSnippet type="inline" feedback="Copied">
                  {fontCss(asset.name)}
                </CodeSnippet>,
              )}
            {asset.durationMs ? row('Duration', formatDuration(asset.durationMs)) : null}
            {row('Size', formatBytes(asset.sizeBytes))}
            {row('Format', asset.contentType)}
            {row('Checksum', <code title={asset.sha256}>{asset.sha256.slice(0, 20)}</code>)}
            {row('Uploaded', formatDateTime(asset.createdAt))}
            {row('Uploaded by', asset.createdByName ?? 'Unknown')}
            {row(
              'Used in',
              usedIn.length === 0
                ? 'No scene'
                : usedIn.map((scene, index) => (
                    <span key={scene.id}>
                      {index > 0 && ', '}
                      <CarbonLink as={Link} inline to={signagePaths.scene(scene.id)} onClick={onClose}>
                        {scene.name}
                      </CarbonLink>
                    </span>
                  )),
            )}
          </StructuredListBody>
        </StructuredListWrapper>
        {canEdit && (
          <div className="sg-media-detail__rename">
            <TextInput
              id="media-rename"
              labelText="Name"
              maxLength={150}
              value={name}
              invalid={name.trim() === ''}
              invalidText="A media file needs a name"
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              kind="tertiary"
              size="md"
              disabled={!renamed || name.trim() === '' || rename.isPending}
              onClick={() => rename.mutate()}
            >
              {rename.isPending ? 'Renaming…' : 'Rename'}
            </Button>
          </div>
        )}
        {rename.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not renamed"
            subtitle={errorMessage(rename.error)}
          />
        )}
        {canEdit && (
          <div>
            <Button kind="danger--tertiary" size="md" onClick={() => setDeleting(true)}>
              Delete media
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
