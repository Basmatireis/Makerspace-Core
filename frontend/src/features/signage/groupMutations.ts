import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SignageDisplay, SignageDisplayGroup, UpdateSignageDisplayGroupRequest } from '../../api/generated/models';
import { updateSignageDisplay, updateSignageDisplayGroup } from '../../api/generated/signage/signage';
import { useRuleNames } from './displayHooks';
import { settingsOf } from './displayMutations';
import { isStaleWrite } from './helpers';
import { useMakerspaceTimeZone, useNow } from './preview';
import { resolvePublished, type PublishedView } from './publishedView';
import { groupPreviewQuery, signageKeys } from './queries';

/** Refreshes a group and everything that follows its drafts: lists, rules, preview and the members' pending changes. */
export function useRefreshGroup(groupId: string) {
  const queryClient = useQueryClient();
  return (...extra: (readonly unknown[])[]) =>
    Promise.all(
      [
        signageKeys.group(groupId),
        signageKeys.groups(),
        signageKeys.groupRules(groupId),
        signageKeys.groupPreview(groupId),
        signageKeys.displays(),
        ...extra,
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}

/** Settings and default-list writes quote the group version; rule writes share it, so a settings write refreshes the rules too. */
export function useUpdateGroup(groupId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshGroup(groupId);
  return useMutation({
    mutationFn: (request: UpdateSignageDisplayGroupRequest) => updateSignageDisplayGroup(groupId, request),
    onSuccess: async (updated: SignageDisplayGroup) => {
      queryClient.setQueryData(signageKeys.group(groupId), updated);
      await refresh();
    },
    onError: (error) => {
      if (isStaleWrite(error)) void refresh();
    },
  });
}

/**
 * Moves standalone displays into a group, one write each. A display in a group has no rules and no default list of
 * its own, so the request sends none and the server deletes the display's own.
 */
export function useJoinGroup(groupId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshGroup(groupId);
  return useMutation({
    mutationFn: async (displays: SignageDisplay[]) => {
      for (const display of displays)
        await updateSignageDisplay(display.id, {
          ...settingsOf(display),
          expectedVersion: display.version,
          groupId,
          defaultScenes: [],
        });
    },
    onSettled: async (_data, _error, displays) => {
      for (const display of displays) {
        queryClient.removeQueries({ queryKey: signageKeys.rules(display.id) });
        void queryClient.invalidateQueries({ queryKey: signageKeys.display(display.id) });
      }
      await refresh();
    },
  });
}

/** Takes a display out of its group; the server gives it a copy of the group's rules and default list. */
export function useLeaveGroup(groupId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshGroup(groupId);
  return useMutation({
    mutationFn: (display: SignageDisplay) =>
      updateSignageDisplay(display.id, {
        ...settingsOf(display),
        expectedVersion: display.version,
        groupId: null,
        defaultScenes: [],
      }),
    onSettled: async (_data, _error, display) => {
      queryClient.removeQueries({ queryKey: signageKeys.rules(display.id) });
      void queryClient.invalidateQueries({ queryKey: signageKeys.display(display.id) });
      await refresh();
    },
  });
}

/** The group's preview publication run through the shared engine; polls like a player. Mirrors `usePublishedView`. */
export function useGroupPublishedView(groupId: string, enabled = true) {
  const preview = useQuery(groupPreviewQuery(groupId, enabled));
  const timeZone = useMakerspaceTimeZone();
  const names = useRuleNames();
  const now = useNow(1000);
  const view: PublishedView | null = useMemo(
    () => (preview.data ? resolvePublished(preview.data, { now, timeZone, names }) : null),
    [preview.data, now, timeZone, names],
  );
  return { preview, view, now };
}
