import { formatBytes } from './helpers';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const VIDEO_TYPES = ['video/mp4'];
export const FONT_TYPES = ['font/woff2'];
const IMAGE_LIMIT = 20 << 20;
const VIDEO_LIMIT = 200 << 20;
const FONT_LIMIT = 2 << 20;

/** Some systems report no type for .woff2 files, so the extension decides then. */
export const contentTypeOf = (file: Pick<File, 'name' | 'type'>) =>
  file.type === '' && /\.woff2$/i.test(file.name) ? 'font/woff2' : file.type;

/** Why a file cannot be uploaded, or null. Mirrors the server: type and size limits per kind. */
export function validateUpload(file: Pick<File, 'name' | 'type' | 'size'>): string | null {
  const type = contentTypeOf(file);
  const image = IMAGE_TYPES.includes(type);
  const font = FONT_TYPES.includes(type);
  if (!image && !font && !VIDEO_TYPES.includes(type)) return 'Use JPG, PNG, WebP, MP4 or WOFF2';
  const limit = image ? IMAGE_LIMIT : font ? FONT_LIMIT : VIDEO_LIMIT;
  return file.size > limit ? `Too large (limit ${formatBytes(limit)})` : null;
}
