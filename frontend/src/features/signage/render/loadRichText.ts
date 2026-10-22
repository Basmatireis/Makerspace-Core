// Loads the sanitizer and markdown renderer (richText.ts, about 20 kB gzip) on first use, so the player's initial
// JavaScript stays within its budget. The build lists the chunk in the player's precache (vite.config.ts).

export type RichTextLibrary = typeof import('./richText');

let library: RichTextLibrary | null = null;
let loading: Promise<RichTextLibrary> | null = null;

/** The library when it has been loaded already. */
export const loadedRichText = (): RichTextLibrary | null => library;

/** Loads the library once; a failed load is retried by the next caller. */
export function loadRichText(): Promise<RichTextLibrary> {
  loading ??= import('./richText').then(
    (module) => {
      library = module;
      return module;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}
