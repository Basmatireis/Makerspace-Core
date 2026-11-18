import { FileUploaderButton, InlineNotification } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { uploadPdfTemplateAsset } from '../../../../api/generated/pdf-templates/pdf-templates';
import { pdfTemplateAssetsKey, pdfTemplateAssetsQuery } from '../../queries';
import { assetProblem } from '../../assets';
import { SelectField, type Change } from '../fields/Inputs';

const KINDS = {
  picture: { accept: ['image/png', 'image/jpeg'], what: 'PNG or JPEG', none: 'Choose an image' },
  graphic: { accept: ['image/svg+xml'], what: 'SVG', none: 'HTU letterhead (full page)' },
} as const;

/**
 * Chooses an uploaded file for a picture (PNG/JPEG) or for a graphic (SVG artwork, or the built-in letterhead) and
 * uploads new ones. The value is the asset id (picture) or `htu-letterhead` / `asset:<id>` (graphic).
 */
export function AssetSelect({
  kind,
  value,
  onChange,
}: {
  kind: 'picture' | 'graphic';
  value: string;
  onChange: Change<string>;
}) {
  const info = KINDS[kind];
  const queryClient = useQueryClient();
  const assets = useQuery(pdfTemplateAssetsQuery());
  const [problem, setProblem] = useState<string | null>(null);
  const prefix = kind === 'graphic' ? 'asset:' : '';
  const usable = (assets.data ?? []).filter((a) => (info.accept as readonly string[]).includes(a.contentType));
  const upload = useMutation({
    mutationFn: (file: File) => uploadPdfTemplateAsset(file, { fileName: file.name }),
    onSuccess: (asset) => {
      void queryClient.invalidateQueries({ queryKey: pdfTemplateAssetsKey });
      setProblem(null);
      onChange(prefix + asset.id, 'step');
    },
    onError: (error) => setProblem(error instanceof Error ? error.message : 'The upload failed.'),
  });
  const options = [
    { value: kind === 'graphic' ? 'htu-letterhead' : '', label: info.none },
    ...(kind === 'graphic'
      ? [
          { value: 'htu-logo', label: 'HTU logo' },
          { value: 'htu-corner-top', label: 'HTU corner, top' },
          { value: 'htu-corner-bottom', label: 'HTU corner, bottom' },
          { value: 'htu-footer', label: 'HTU footer' },
        ]
      : []),
    ...usable.map((a) => ({
      value: prefix + a.id,
      label: `${a.fileName}${a.width ? ` · ${a.width} × ${a.height} px` : ''}`,
    })),
  ];
  // An asset that was deleted, or is not listed yet, stays visible instead of silently showing the first option.
  const shown = options.some((o) => o.value === value) ? value : '';
  return (
    <div className="pdft-asset">
      <SelectField
        label={kind === 'picture' ? 'File' : 'Artwork'}
        value={shown}
        options={options}
        helper={`${info.what} uploaded for templates, max. 2 MB.`}
        onChange={onChange}
      />
      <FileUploaderButton
        labelText={`Upload ${info.what}`}
        accept={[...info.accept]}
        buttonKind="tertiary"
        size="sm"
        disableLabelChanges
        disabled={upload.isPending}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          const bad = assetProblem(file, info.accept);
          setProblem(bad);
          if (!bad) upload.mutate(file);
        }}
      />
      {(problem || assets.isError) && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title={problem ? 'Not uploaded' : 'The files could not be loaded'}
          subtitle={problem ?? (assets.error instanceof Error ? assets.error.message : '')}
        />
      )}
    </div>
  );
}
