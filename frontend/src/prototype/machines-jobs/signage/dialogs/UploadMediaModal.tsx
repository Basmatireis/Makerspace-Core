import { useState } from 'react';
import { FileUploaderDropContainer, FileUploaderItem, InlineNotification, Modal, Stack } from '@carbon/react';
import { useStore } from '../../store';
import { poster } from '../mockData';
import { uid } from '../helpers';
import { useSignage } from '../SignageContext';
import type { MediaItem } from '../types';

const IMAGE_LIMIT = 20 * 1_048_576;
const VIDEO_LIMIT = 500 * 1_048_576;
type Picked = { id: string; file: File; error: string | null };

function probe(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 1920, height: image.naturalHeight || 1080 });
    image.onerror = () => resolve({ width: 1920, height: 1080 });
    image.src = url;
  });
}

/** Mock upload: images are kept as local object URLs, videos get a generated poster and convert for a few seconds. */
export function UploadMediaModal({ onClose }: { onClose: () => void }) {
  const signage = useSignage();
  const store = useStore();
  const [picked, setPicked] = useState<Picked[]>([]);
  const [busy, setBusy] = useState(false);

  const add = (files: File[]) => setPicked((current) => [...current, ...files.map((file) => {
    const isImage = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
    const isVideo = file.type === 'video/mp4';
    const error = !isImage && !isVideo ? 'Use JPG, PNG, WebP or MP4' : file.size > (isImage ? IMAGE_LIMIT : VIDEO_LIMIT) ? `Too large (limit ${isImage ? '20' : '500'} MB)` : null;
    return { id: uid('up'), file, error };
  })]);

  const upload = async () => {
    const valid = picked.filter((entry) => !entry.error);
    if (valid.length === 0) return;
    setBusy(true);
    for (const { file } of valid) {
      const isVideo = file.type === 'video/mp4';
      const url = isVideo ? '' : URL.createObjectURL(file);
      const size = isVideo ? { width: 1920, height: 1080 } : await probe(url);
      const item: MediaItem = {
        id: uid('media'), name: file.name, kind: isVideo ? 'video' : 'image', width: size.width, height: size.height, sizeBytes: file.size, format: isVideo ? 'MP4' : file.type.replace('image/', '').toUpperCase(),
        checksum: `sha256:${Math.random().toString(16).slice(2, 10)}${Math.random().toString(16).slice(2, 10)}`, uploadedBy: 'Mira Kovac', uploadedAt: new Date().toISOString(),
        src: isVideo ? poster([file.name.replace(/\.[^.]+$/, '')], 'Video', '#262626', '#6929c4', 1920, 1080) : url, status: isVideo ? 'converting' : 'ready',
      };
      signage.addMedia(item);
    }
    store.notify({ kind: 'success', title: valid.length === 1 ? 'Media uploaded' : `${valid.length} files uploaded`, subtitle: valid.some((entry) => entry.file.type === 'video/mp4') ? 'Videos convert for playback first.' : undefined });
    onClose();
  };

  return (
    <Modal open size="md" modalHeading="Upload media" modalLabel="Media" primaryButtonText={busy ? 'Uploading…' : 'Upload'} secondaryButtonText="Cancel" primaryButtonDisabled={busy || picked.filter((entry) => !entry.error).length === 0}
      preventCloseOnClickOutside onRequestClose={onClose} onRequestSubmit={() => { void upload(); }}>
      <Stack gap={5}>
        <FileUploaderDropContainer labelText="Drag and drop files here or click to upload" accept={['image/jpeg', 'image/png', 'image/webp', 'video/mp4']} multiple name="signage-media" onAddFiles={(_, { addedFiles }) => add(addedFiles)} />
        <p className="mj-secondary">Images: JPG, PNG, WebP up to 20 MB. Videos: MP4 up to 500 MB. Core re-encodes videos that are not H.264.</p>
        {picked.map((entry) => (
          <FileUploaderItem key={entry.id} name={entry.file.name} status="edit" invalid={Boolean(entry.error)} errorSubject={entry.error ?? undefined} errorBody="" onDelete={() => setPicked((current) => current.filter((item) => item.id !== entry.id))} />
        ))}
        {picked.some((entry) => entry.error) && <InlineNotification kind="warning" lowContrast hideCloseButton title="Some files are skipped" subtitle="Remove them or pick other files." />}
      </Stack>
    </Modal>
  );
}
