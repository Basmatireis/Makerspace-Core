// Which build files the player's service worker precaches. Used by the build (vite.config.ts) only; kept free of imports
// so the build configuration can load it and a test can check it.

export type BuildManifest = Record<
  string,
  { file: string; imports?: string[]; dynamicImports?: string[]; css?: string[]; assets?: string[] }
>;

/**
 * The hashed files of the player entry: its static imports, CSS and the assets the CSS references (the IBM Plex fonts)
 * plus its lazy chunks (the rich text renderer), transitively. Sorted, so the list (and the worker's version hash) is
 * stable.
 */
export function playerShellFiles(manifest: BuildManifest): string[] {
  const files = new Set<string>();
  const visit = (key: string) => {
    const chunk = manifest[key];
    if (!chunk || files.has(`/${chunk.file}`)) return;
    files.add(`/${chunk.file}`);
    chunk.css?.forEach((css) => files.add(`/${css}`));
    chunk.assets?.forEach((asset) => files.add(`/${asset}`));
    chunk.imports?.forEach(visit);
    chunk.dynamicImports?.forEach(visit);
  };
  visit('player.html');
  return Array.from(files).sort();
}
