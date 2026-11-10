import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { SignageScene } from '../../../api/generated/models';
import { updateSignageScene } from '../../../api/generated/signage/signage';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { deepEqual } from '../editorHistory';
import { errorMessage, isStaleWrite } from '../helpers';
import { sceneQuery, signageKeys } from '../queries';
import { draftError, draftRequest, toDraft, type Draft } from '../sceneDraft';

/** Quiet time after the last change before the draft is saved. */
export const AUTOSAVE_DELAY_MS = 800;

export type SaveStatus =
  | { kind: 'saved' }
  | { kind: 'pending' }
  | { kind: 'saving' }
  /** The draft would certainly be rejected (empty name, invalid colour ...); nothing is sent until it is fixed. */
  | { kind: 'invalid'; message: string }
  | { kind: 'error'; message: string }
  /** Someone else saved the screen since it was loaded (409). */
  | { kind: 'conflict'; message: string | null };

/** The draft as it is sent: trimmed name and lower-case colour, so a saved screen does not look edited. */
const normalized = (draft: Draft): Draft => ({
  ...draft,
  name: draft.name.trim(),
  backgroundColor: draft.backgroundColor.toLowerCase(),
});

type Saved = { draft: Draft; version: number };
type Failure = { kind: 'error'; message: string; draft: Draft } | { kind: 'conflict'; message: string | null };

/**
 * Saves the editor draft on its own: AUTOSAVE_DELAY_MS after the last change, one request at a time (the newest draft
 * goes next), with the version of the last response as `expectedVersion`. A 409 stops saving until the person loads
 * the latest version (`onReplace` resets the editor to it) or keeps their changes (saved over it).
 */
export function useAutosave({
  scene,
  draft,
  enabled,
  onReplace,
}: {
  scene: SignageScene;
  draft: Draft;
  enabled: boolean;
  onReplace: (fresh: SignageScene) => void;
}) {
  const queryClient = useQueryClient();
  const [saved, setSaved] = useState<Saved>(() => ({ draft: toDraft(scene), version: scene.version }));
  const [inFlight, setInFlight] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // Read by the async save; `saved` mirrors it for rendering.
  const savedRef = useRef(saved);
  const running = useRef<Promise<boolean> | null>(null);

  const dirty = enabled && !deepEqual(normalized(draft), saved.draft);
  const problem = dirty ? draftError(draft) : null;

  const remember = (next: Saved) => {
    savedRef.current = next;
    setSaved(next);
  };

  const send = useLatestCallback(async (): Promise<boolean> => {
    const sending = normalized(draft);
    if (!enabled || deepEqual(sending, savedRef.current.draft)) return true;
    if (draftError(draft) !== null) return false;
    setInFlight(true);
    setFailure(null);
    try {
      const next = await updateSignageScene(scene.id, draftRequest(sending, savedRef.current.version));
      remember({ draft: sending, version: next.version });
      queryClient.setQueryData(signageKeys.scene(scene.id), next);
      void queryClient.invalidateQueries({ queryKey: signageKeys.scenes(), exact: true });
      return true;
    } catch (error) {
      setFailure(
        isStaleWrite(error)
          ? { kind: 'conflict', message: null }
          : { kind: 'error', message: errorMessage(error, 'The screen could not be saved.'), draft },
      );
      return false;
    } finally {
      setInFlight(false);
    }
  });

  /** Saves now (after a request in flight); true when the draft on the server matches this one. */
  const saveNow = useLatestCallback(async (): Promise<boolean> => {
    while (running.current) await running.current;
    const run = send();
    running.current = run;
    try {
      return await run;
    } finally {
      running.current = null;
    }
  });

  // An error waits for a retry unless the person changes something; a conflict always waits for their choice.
  const blocked = failure !== null && (failure.kind === 'conflict' || failure.draft === draft);
  useEffect(() => {
    if (!dirty || problem !== null || blocked || inFlight) return;
    const timer = setTimeout(() => void saveNow(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, dirty, problem, blocked, inFlight, saveNow]);

  const fetchLatest = async () => {
    try {
      return await queryClient.fetchQuery({ ...sceneQuery(scene.id), staleTime: 0 });
    } catch (error) {
      setFailure({ kind: 'conflict', message: errorMessage(error, 'The latest version could not be loaded.') });
      return null;
    }
  };

  const loadLatest = async () => {
    const fresh = await fetchLatest();
    if (!fresh) return;
    remember({ draft: toDraft(fresh), version: fresh.version });
    setFailure(null);
    onReplace(fresh);
  };

  const keepMine = async () => {
    const fresh = await fetchLatest();
    if (!fresh) return;
    remember({ draft: toDraft(fresh), version: fresh.version });
    setFailure(null);
    await saveNow();
  };

  let status: SaveStatus;
  if (failure?.kind === 'conflict') status = { kind: 'conflict', message: failure.message };
  else if (inFlight) status = { kind: 'saving' };
  else if (failure?.kind === 'error') status = { kind: 'error', message: failure.message };
  else if (problem !== null) status = { kind: 'invalid', message: problem };
  else if (dirty) status = { kind: 'pending' };
  else status = { kind: 'saved' };

  return {
    status,
    /** True while the draft differs from the saved screen: the leave warning applies. */
    unsaved: dirty,
    version: saved.version,
    saveNow,
    retry: () => void saveNow(),
    loadLatest,
    keepMine,
  };
}
