import { useSyncExternalStore } from 'react';
import type { CurrentUser } from '../../api/generated/models';
import { setApiTransport } from '../../api/http-client';
import { queryClient } from '../../api/query-client';
import { authQueryKey } from '../auth/auth';

/**
 * Demo mode answers every API request in the browser with sample data (see `./fake`). The fake backend is a lazily
 * loaded chunk, so this module stays tiny; nothing here touches browser storage or the network.
 */
let active = false;
// Bumped by every enter and exit so that a slow chunk load cannot activate demo mode after the person left it.
let generation = 0;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

const keepsSession = (query: { queryKey: readonly unknown[] }) => query.queryKey.join('/') !== authQueryKey.join('/');

/**
 * Drops every cached response and refetches the mounted queries from the current transport. `resetQueries` is
 * used instead of a plain clear because the shell and the open page stay mounted and must load again at once.
 * The signed-in user stays: the demo is served as that same user, and resetting it would send the protected shell
 * back to its loading screen, which unmounts the running tour.
 */
function reloadQueries(): void {
  void queryClient.cancelQueries({ predicate: keepsSession });
  void queryClient.resetQueries({ predicate: keepsSession });
}

export function isDemoMode(): boolean {
  return active;
}

export function subscribeDemoMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDemoMode(): boolean {
  return useSyncExternalStore(subscribeDemoMode, isDemoMode);
}

/** Starts demo mode as `user`: their real permissions decide what the sample data lets them do. */
export async function enterDemoMode(user: CurrentUser): Promise<void> {
  const mine = ++generation;
  const { createDemoTransport } = await import('./fake/backend');
  if (mine !== generation) return;
  setApiTransport(createDemoTransport(user));
  active = true;
  reloadQueries();
  notify();
}

/** Leaves demo mode: the sample store is discarded and the real data is loaded again. */
export async function exitDemoMode(): Promise<void> {
  generation += 1;
  if (!active) return;
  active = false;
  setApiTransport(null);
  reloadQueries();
  notify();
}
