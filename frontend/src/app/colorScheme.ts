import { useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react';

/** The staff application's two Carbon themes: the default white theme and g100. */
export type ColorScheme = 'light' | 'dark';

// Only the person's explicit choice is stored, and only while it differs from the system setting: a UI preference,
// never private data.
const STORAGE_KEY = 'makerspace.colorScheme';
const DARK_QUERY = '(prefers-color-scheme: dark)';
/** Carbon's zone class for g100; on <html> it themes portalled menus and modals too. */
const DARK_CLASS = 'cds--g100';

const listeners = new Set<() => void>();
let choice: ColorScheme | null = null;
try {
  const stored = localStorage.getItem(STORAGE_KEY);
  choice = stored === 'light' || stored === 'dark' ? stored : null;
} catch {
  // Storage may be blocked; the system setting applies.
}

const systemScheme = (): ColorScheme =>
  typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';

const currentScheme = () => choice ?? systemScheme();

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null;
  media?.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    media?.removeEventListener('change', listener);
  };
}

/** The active color scheme: the person's choice, otherwise `prefers-color-scheme`. */
export function useColorScheme(): ColorScheme {
  return useSyncExternalStore(subscribe, currentScheme);
}

/** Switches the scheme; choosing what the system prefers drops the override so later system changes apply again. */
export function setColorScheme(next: ColorScheme) {
  choice = next === systemScheme() ? null : next;
  try {
    if (choice) localStorage.setItem(STORAGE_KEY, choice);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // The choice still holds for this page view.
  }
  listeners.forEach((listener) => listener());
}

/**
 * Applies the color scheme to the document while mounted. Staff and sign-in pages render it; the kiosk, visitor and
 * public pages do not, so they keep their own light styling.
 */
export function ColorSchemeRoot({ children }: { children: ReactNode }) {
  const scheme = useColorScheme();
  useLayoutEffect(() => {
    const root = document.documentElement.classList;
    root.toggle(DARK_CLASS, scheme === 'dark');
    return () => root.remove(DARK_CLASS);
  }, [scheme]);
  return children;
}
