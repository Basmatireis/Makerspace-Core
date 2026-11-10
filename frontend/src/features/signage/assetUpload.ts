import type { SignageAsset } from '../../api/generated/models';
import { getUploadSignageAssetUrl } from '../../api/generated/signage/signage';
import { apiFetch } from '../../api/http-client';
import { contentTypeOf, VIDEO_TYPES } from './uploadValidation';
import { readVideoMetadata } from './videoMetadata';

/** Header values are ASCII-only, so the name travels percent-encoded as UTF-8 (the server stores at most 150 characters). */
const encodedName = (name: string) =>
  encodeURIComponent(
    Array.from(name.replace(/\p{Cc}/gu, ''))
      .slice(0, 150)
      .join('') || 'upload',
  );

/** Sends the raw bytes with the headers the API expects. Images are measured by the server, videos by the browser. */
export async function uploadAssetFile(file: File): Promise<SignageAsset> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-File-Name': encodedName(file.name),
    'X-File-Content-Type': contentTypeOf(file),
  };
  if (VIDEO_TYPES.includes(file.type)) {
    const metadata = await readVideoMetadata(file);
    headers['X-Asset-Width'] = String(metadata.width);
    headers['X-Asset-Height'] = String(metadata.height);
    headers['X-Asset-Duration-Ms'] = String(metadata.durationMs);
  }
  return apiFetch<SignageAsset>(getUploadSignageAssetUrl(), { method: 'POST', headers, body: file });
}
