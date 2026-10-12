import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { useLatestCallback } from './useLatestCallback';

export type DiscardAction = () => void;
export type UnsavedChangesLocation = { pathname: string; search: string; hash: string };

export type UseUnsavedChangesOptions = {
  isDirty: boolean;
  onDiscard?: () => void;
  shouldBlockNavigation?: (currentLocation: UnsavedChangesLocation, nextLocation: UnsavedChangesLocation) => boolean;
};

export type UnsavedChangesGuard = {
  requestDiscard: (action: DiscardAction) => void;
  bypassAfterSubmit: (action: DiscardAction) => void;
  dialogOpen: boolean;
  confirmDiscard: () => void;
  keepEditing: () => void;
};

function routeChanged(
  currentLocation: UnsavedChangesLocation,
  nextLocation: UnsavedChangesLocation,
) {
  return currentLocation.pathname !== nextLocation.pathname
    || currentLocation.search !== nextLocation.search
    || currentLocation.hash !== nextLocation.hash;
}

export function useUnsavedChanges({
  isDirty,
  onDiscard,
  shouldBlockNavigation,
}: UseUnsavedChangesOptions): UnsavedChangesGuard {
  const [pendingAction, setPendingAction] = useState<DiscardAction | null>(null);
  const bypassRef = useRef(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => (
    isDirty && !bypassRef.current && routeChanged(currentLocation, nextLocation)
      && (shouldBlockNavigation?.(currentLocation, nextLocation) ?? true)
  ));

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (isDirty && !bypassRef.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [isDirty]);

  const runWithBypass = useCallback((action: DiscardAction) => {
    bypassRef.current = true;
    try {
      action();
    } finally {
      window.queueMicrotask(() => {
        bypassRef.current = false;
      });
    }
  }, []);

  const requestDiscard = useLatestCallback((action: DiscardAction) => {
    if (isDirty) {
      setPendingAction(() => action);
      return;
    }
    action();
  });

  const bypassAfterSubmit = useCallback((action: DiscardAction) => {
    runWithBypass(action);
  }, [runWithBypass]);

  const keepEditing = useCallback(() => {
    setPendingAction(null);
    if (blocker.state === 'blocked') blocker.reset();
  }, [blocker]);

  const confirmDiscard = useCallback(() => {
    onDiscard?.();
    setPendingAction(null);
    if (blocker.state === 'blocked') {
      blocker.proceed();
      return;
    }
    if (pendingAction) runWithBypass(pendingAction);
  }, [blocker, onDiscard, pendingAction, runWithBypass]);

  return {
    requestDiscard,
    bypassAfterSubmit,
    dialogOpen: pendingAction !== null || blocker.state === 'blocked',
    confirmDiscard,
    keepEditing,
  };
}
