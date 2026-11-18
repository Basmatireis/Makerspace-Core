/** Uploads are limited like the server: 2 MB. */
export const MAX_ASSET_BYTES = 2 * 1024 * 1024;

/** The first problem with a file the person chose, or null. */
export function assetProblem(file: { size: number; type: string }, accept: readonly string[]): string | null {
  if (!accept.includes(file.type))
    return 'Only these files can be used here: ' + accept.map((t) => t.split('/')[1]).join(', ') + '.';
  if (file.size > MAX_ASSET_BYTES) return 'The file is larger than 2 MB.';
  return null;
}
