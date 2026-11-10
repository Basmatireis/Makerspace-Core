import { useRef, useState } from 'react';
import { Dropdown, InlineLoading, InlineNotification } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { uploadAssetFile } from './assetUpload';
import { errorMessage } from './helpers';
import { assetsQuery, signageKeys } from './queries';
import { IMAGE_TYPES, validateUpload, VIDEO_TYPES } from './uploadValidation';

type Entry = { key: string; label: string; assetId: string | null; upload?: boolean };

const KIND = {
  image: { noun: 'an image', accept: IMAGE_TYPES, formats: 'JPG, PNG or WebP', upload: 'Upload an image…' },
  video: { noun: 'a video', accept: VIDEO_TYPES, formats: 'an MP4 video', upload: 'Upload a video…' },
} as const;

/**
 * Picks an image or video from Media. With `signage.content.manage` the last entry uploads a new file through the
 * asset API (type and size checked like the Media page) and selects it. `value` is the asset id.
 */
export function MediaPicker({
  id,
  labelText,
  kind,
  value,
  onChange,
  allowNone = false,
  helperText,
}: {
  id: string;
  labelText: string;
  kind: 'image' | 'video';
  value: string | null;
  onChange: (id: string | null) => void;
  allowNone?: boolean;
  helperText?: string;
}) {
  const canUpload = hasPermission(useCurrentUser(), PermissionId.signagecontentmanage);
  const queryClient = useQueryClient();
  const assets = useQuery(assetsQuery());
  const input = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const config = KIND[kind];
  const upload = useMutation({
    mutationFn: uploadAssetFile,
    onSuccess: async (asset) => {
      // The list is refreshed first so the new file is among the choices when it becomes the selected one.
      await queryClient.invalidateQueries({ queryKey: signageKeys.assets() });
      onChange(asset.id);
    },
  });

  const entries: Entry[] = [
    ...(allowNone ? [{ key: 'none', label: 'None', assetId: null }] : []),
    ...(assets.data?.items ?? [])
      .filter((asset) => asset.kind === kind)
      .map((asset) => ({ key: asset.id, label: asset.name, assetId: asset.id })),
    ...(canUpload ? [{ key: 'upload', label: config.upload, assetId: null, upload: true }] : []),
  ];
  const selected = value ? (entries.find((entry) => entry.assetId === value) ?? null) : allowNone ? entries[0] : null;
  const missing = Boolean(value) && assets.isSuccess && !selected;

  const choose = (file: File | undefined) => {
    if (!file) return;
    const problem = !config.accept.some((type) => type === file.type)
      ? `That file is not ${config.noun}. Use ${config.formats}.`
      : validateUpload(file);
    setFileError(problem);
    if (!problem) {
      upload.reset();
      upload.mutate(file);
    }
  };

  return (
    <div className="sg-media-picker">
      <Dropdown<Entry>
        id={id}
        titleText={labelText}
        label={assets.isPending ? 'Loading Media…' : `Choose ${config.noun} from Media`}
        items={entries}
        itemToString={(entry) => entry?.label ?? ''}
        // Null keeps the Dropdown controlled when nothing is chosen; its typings only allow undefined.
        selectedItem={selected as Entry}
        disabled={upload.isPending}
        helperText={helperText}
        invalid={missing}
        invalidText="This media no longer exists. Choose another."
        onChange={({ selectedItem }) => {
          if (!selectedItem) return;
          if (selectedItem.upload) input.current?.click();
          else onChange(selectedItem.assetId);
        }}
      />
      {canUpload && (
        <input
          ref={input}
          type="file"
          hidden
          tabIndex={-1}
          aria-label={config.upload}
          data-testid={`${id}-file`}
          accept={config.accept.join(',')}
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      )}
      {upload.isPending && <InlineLoading description={`Uploading ${upload.variables.name}…`} status="active" />}
      {(fileError || upload.isError) && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title={fileError ? 'File not uploaded' : 'Upload failed'}
          subtitle={fileError ?? errorMessage(upload.error, 'The upload failed.')}
        />
      )}
    </div>
  );
}
