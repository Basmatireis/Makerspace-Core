import { useEffect, useMemo, useState } from 'react';
import { Button, FileUploaderDropContainer, InlineNotification, Modal, Stack, Tag, Tile } from '@carbon/react';
import { Renew, TrashCan, Upload } from '@carbon/icons-react';
import { useMutation } from '@tanstack/react-query';
import type { BrandingAsset, BrandingConfiguration } from '../../api/generated/models';
import {
  getPutBrandingAssetUrl,
  removeBrandingAsset,
  restoreDefaultBrandingAsset,
} from '../../api/generated/branding/branding';
import { apiFetch } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { assets, mutationMessage } from './brandingSettings';

export function AssetCard({
  descriptor,
  asset,
  version,
  onApplied,
}: {
  descriptor: (typeof assets)[number];
  asset: BrandingAsset;
  version: number;
  onApplied: (configuration: BrandingConfiguration) => void;
}) {
  const [file, setFile] = useState<File>();
  const [confirm, setConfirm] = useState<'remove' | 'default'>();
  // The object URL is created once per file and revoked by the effect below.
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  const upload = useMutation({
    mutationFn: () =>
      apiFetch<BrandingConfiguration>(getPutBrandingAssetUrl(descriptor.slot, { expectedVersion: version }), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': file!.name },
        body: file,
      }),
    onSuccess: (result) => {
      setFile(undefined);
      onApplied(result);
    },
  });
  const action = useMutation({
    mutationFn: (mode: 'remove' | 'default') =>
      mode === 'remove'
        ? removeBrandingAsset(descriptor.slot, { expectedVersion: version })
        : restoreDefaultBrandingAsset(descriptor.slot, { expectedVersion: version }),
    onSuccess: (result) => {
      setConfirm(undefined);
      onApplied(result);
    },
  });
  const status = asset.mode === 'custom' ? 'Custom' : asset.mode === 'none' ? 'Removed' : 'Built-in default';
  return (
    <Tile className="branding-asset-card">
      <Stack gap={5}>
        <div className="section-heading">
          <h2>{descriptor.title}</h2>
          <Tag type={asset.mode === 'custom' ? 'purple' : asset.mode === 'none' ? 'gray' : 'blue'}>{status}</Tag>
        </div>
        <p className="section-description">{descriptor.guidance}</p>
        {preview || asset.url ? (
          <img className="branding-asset-preview" src={preview ?? asset.url!} alt={`${descriptor.title} preview`} />
        ) : (
          <div className="branding-asset-preview branding-asset-preview--empty">No asset</div>
        )}
        {asset.mode === 'custom' && asset.originalFilename && (
          <p className="section-description">Saved file: {asset.originalFilename}</p>
        )}
        <FileUploaderDropContainer
          id={`asset-${descriptor.slot}`}
          accept={descriptor.accept}
          maxFileSize={descriptor.maxBytes}
          multiple={false}
          labelText="Choose or drop an image"
          onAddFiles={(_, data) => setFile(data.addedFiles[0])}
        />
        {file && <p className="section-description">Selected locally: {file.name}</p>}
        {(upload.isError || action.isError) && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Asset change failed"
            subtitle={mutationMessage(upload.error ?? action.error)}
          />
        )}
        <div className="button-cluster">
          <Button size="sm" renderIcon={Upload} disabled={!file || upload.isPending} onClick={() => upload.mutate()}>
            {upload.isPending ? 'Uploading…' : 'Upload selected'}
          </Button>
          <Button
            size="sm"
            kind="danger--tertiary"
            renderIcon={TrashCan}
            disabled={asset.mode === 'none' || action.isPending}
            onClick={() => {
              action.reset();
              setConfirm('remove');
            }}
          >
            Remove
          </Button>
          <Button
            size="sm"
            kind="tertiary"
            renderIcon={Renew}
            disabled={asset.mode === 'default' || action.isPending}
            onClick={() => {
              action.reset();
              setConfirm('default');
            }}
          >
            Restore default
          </Button>
        </div>
      </Stack>
      <DestructiveActionDialog
        open={confirm === 'remove'}
        title={`Remove ${descriptor.title.toLowerCase()}?`}
        confirmLabel="Remove asset"
        pending={action.isPending}
        error={action.isError ? mutationMessage(action.error) : undefined}
        onClose={() => {
          setConfirm(undefined);
          action.reset();
        }}
        onConfirm={() => action.mutate('remove')}
      >
        <p>
          The custom asset will be permanently removed and this location will intentionally have no asset. This differs
          from restoring the bundled default.
        </p>
      </DestructiveActionDialog>
      <Modal
        open={confirm === 'default'}
        modalHeading={`Restore the default ${descriptor.title.toLowerCase()}?`}
        primaryButtonText={action.isPending ? 'Restoring…' : 'Restore default'}
        primaryButtonDisabled={action.isPending}
        secondaryButtonText="Cancel"
        selectorPrimaryFocus=".cds--btn--secondary"
        preventCloseOnClickOutside
        onRequestClose={() => {
          if (!action.isPending) {
            setConfirm(undefined);
            action.reset();
          }
        }}
        onSecondarySubmit={() => {
          if (!action.isPending) {
            setConfirm(undefined);
            action.reset();
          }
        }}
        onRequestSubmit={() => {
          if (!action.isPending) action.mutate('default');
        }}
      >
        <Stack gap={5}>
          <p>The current override will be replaced by the bundled installation asset.</p>
          {action.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Default not restored"
              subtitle={mutationMessage(action.error)}
            />
          )}
        </Stack>
      </Modal>
    </Tile>
  );
}
