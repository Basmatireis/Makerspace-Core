import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SignageDisplay, UpdateSignageDisplayRequest } from '../../api/generated/models';
import { updateSignageDisplay } from '../../api/generated/signage/signage';
import { isStaleWrite } from './helpers';
import { signageKeys } from './queries';

/** Refreshes everything that depends on a display's drafts: the display (version, pending changes), lists and the live preview. */
export function useRefreshDisplay(displayId: string) {
  const queryClient = useQueryClient();
  return (...extra: (readonly unknown[])[]) =>
    Promise.all(
      [
        signageKeys.display(displayId),
        signageKeys.displays(),
        signageKeys.groups(),
        signageKeys.preview(displayId),
        ...extra,
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}

/** Settings writes quote the display version; rule writes share it, so a settings write refreshes the rule list's version too. */
export function useUpdateDisplay(displayId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshDisplay(displayId);
  return useMutation({
    mutationFn: (request: UpdateSignageDisplayRequest) => updateSignageDisplay(displayId, request),
    onSuccess: async (updated: SignageDisplay) => {
      const before = queryClient.getQueryData<SignageDisplay>(signageKeys.display(displayId));
      queryClient.setQueryData(signageKeys.display(displayId), updated);
      // The old and the new group list this display as a member and own the rules it plays.
      const groupIds = new Set([before?.groupId, updated.groupId].filter((id): id is string => Boolean(id)));
      await refresh(
        signageKeys.rules(displayId),
        ...[...groupIds].flatMap((id) => [
          signageKeys.group(id),
          signageKeys.groupRules(id),
          signageKeys.groupPreview(id),
        ]),
      );
    },
    onError: (error) => {
      if (isStaleWrite(error)) void refresh(signageKeys.rules(displayId));
    },
  });
}

/** The writable settings of a display, to change one of them without touching the rest. */
export const settingsOf = (display: SignageDisplay): Omit<UpdateSignageDisplayRequest, 'expectedVersion'> => ({
  allowCameraOutside: display.allowCameraOutside,
  name: display.name,
  location: display.location,
  aspectRatio: display.aspectRatio,
  visibleFromOutside: display.visibleFromOutside,
  groupId: display.groupId,
  defaultScenes: display.defaultScenes,
});
