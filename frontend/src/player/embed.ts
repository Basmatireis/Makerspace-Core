// Web embed mode: the player page also runs at /embed/{key} inside an iframe on other websites.

const EMBED_PATH = /^\/embed\/([A-Za-z0-9_-]{20,64})\/?$/;

/** The embed key of a page path, or null for the normal (device) player. */
export const embedKeyFromPath = (pathname: string): string | null => EMBED_PATH.exec(pathname)?.[1] ?? null;

/** True when the page is not inside a frame. Cross-origin parents are never readable, so a thrown access means framed. */
export const isTopLevel = (win: Pick<Window, 'top' | 'self'> = window): boolean => {
  try {
    return win.top === win.self;
  } catch {
    return false;
  }
};
