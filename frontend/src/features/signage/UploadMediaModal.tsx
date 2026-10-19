import { useState } from 'react';
import { FileUploaderDropContainer, FileUploaderItem, InlineNotification, Modal, Stack } from '@carbon/react';
import { useQueryClient } from '@tanstack/react-query';
import type { SignageAsset } from '../../api/generated/models';
import { getUploadSignageAssetUrl } from '../../api/generated/signage/signage';
import { apiFetch } from '../../api/http-client';
import { errorMessage, formatBytes } from './helpers';
import { readVideoMetadata } from './videoMetadata';
import { signageKeys } from './queries';

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const VIDEO_TYPES = ['video/mp4'];
const IMAGE_LIMIT = 20 << 20;
const VIDEO_LIMIT = 200 << 20;

type Picked = { id: number; file: File; error: string | null; status: 'edit' | 'uploading' | 'complete' };
let nextId = 0;

function validate(file: File): string | null {
  const image = IMAGE_TYPES.includes(file.type);
  if (!image && !VIDEO_TYPES.includes(file.type)) return 'Use JPG, PNG, WebP or MP4';
  const limit = image ? IMAGE_LIMIT : VIDEO_LIMIT;
  return file.size > limit ? `Too large (limit ${formatBytes(limit)})` : null;
}

/** Header values are ASCII-only, so the name travels percent-encoded as UTF-8 (the server stores at most 150 characters). */
const encodedName = (name: string) => encodeURIComponent(Array.from(name.replace(/\p{Cc}/gu, '')).slice(0, 150).join('') || 'upload');

/** Sends the raw bytes with the headers the API expects. Images are measured by the server, videos by the browser. */
async function uploadFile(file: File): Promise<SignageAsset> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodedName(file.name), 'X-File-Content-Type': file.type };
  if (VIDEO_TYPES.includes(file.type)) {
    const metadata = await readVideoMetadata(file);
    headers['X-Asset-Width'] = String(metadata.width);
    headers['X-Asset-Height'] = String(metadata.height);
    headers['X-Asset-Duration-Ms'] = String(metadata.durationMs);
  }
  return apiFetch<SignageAsset>(getUploadSignageAssetUrl(), { method: 'POST', headers, body: file });
}

export function UploadMediaModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);
  const patch = (id: number, change: Partial<Picked>) => setPicked((current) => current.map((entry) => entry.id === id ? { ...entry, ...change } : entry));
  const ready = picked.filter((entry) => !entry.error && entry.status === 'edit');

  const add = (files: File[]) => setPicked((current) => [...current, ...files.map((file) => ({ id: (nextId += 1), file, error: validate(file), status: 'edit' as const }))]);

  const upload = async () => {
    setBusy(true);
    let failed = 0;
    for (const entry of ready) {
      patch(entry.id, { status: 'uploading', error: null });
      try {
        await uploadFile(entry.file);
        patch(entry.id, { status: 'complete' });
      } catch (error) {
        failed += 1;
        patch(entry.id, { status: 'edit', error: errorMessage(error, 'Upload failed') });
      }
    }
    await queryClient.invalidateQueries({ queryKey: signageKeys.assets() });
    setBusy(false);
    if (failed === 0) onClose();
  };

  return (
    <Modal open size="md" modalHeading="Upload media" modalLabel="Media" primaryButtonText={busy ? 'Uploading…' : 'Upload'} secondaryButtonText={busy ? 'Close when finished' : 'Cancel'} primaryButtonDisabled={busy || ready.length === 0}
      preventCloseOnClickOutside onRequestClose={() => { if (!busy) onClose(); }} onRequestSubmit={() => { void upload(); }}>
      <Stack gap={5}>
        <FileUploaderDropContainer labelText="Drag and drop files here or click to upload" accept={[...IMAGE_TYPES, ...VIDEO_TYPES]} multiple name="signage-media" disabled={busy} onAddFiles={(_, { addedFiles }) => add(addedFiles)} />
        <p className="sg-secondary">Images: JPG, PNG, WebP up to 20 MB and 8192 px per side. Videos: H.264 MP4 up to 200 MB. Videos are played as uploaded.</p>
        {picked.map((entry) => (
          <FileUploaderItem
            key={entry.id} name={entry.file.name} status={entry.status} invalid={Boolean(entry.error)} errorSubject={entry.error ?? undefined} errorBody="" size="md"
            onDelete={() => { if (!busy) setPicked((current) => current.filter((item) => item.id !== entry.id)); }}
          />
        ))}
        {picked.some((entry) => entry.error) && <InlineNotification kind="warning" lowContrast hideCloseButton title="Some files are not uploaded" subtitle="Remove them or pick other files." />}
      </Stack>
    </Modal>
  );
}
