import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SignageDisplay, UpdateSignageDisplayRequest } from '../../api/generated/models';
import { updateSignageDisplay } from '../../api/generated/signage/signage';
import { isStaleWrite } from './helpers';
import { signageKeys } from './queries';

/** Refreshes everything that depends on a display's drafts: the display (version, pending changes), lists and the live preview. */
export function useRefreshDisplay(displayId: string) {
  const queryClient = useQueryClient();
  return (...extra: (readonly unknown[])[]) => Promise.all([signageKeys.display(displayId), signageKeys.displays(), signageKeys.preview(displayId), ...extra].map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}

/** Settings writes quote the display version; rule writes share it, so a settings write refreshes the rule list's version too. */
export function useUpdateDisplay(displayId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshDisplay(displayId);
  return useMutation({
    mutationFn: (request: UpdateSignageDisplayRequest) => updateSignageDisplay(displayId, request),
    onSuccess: async (updated: SignageDisplay) => {
      queryClient.setQueryData(signageKeys.display(displayId), updated);
      await refresh(signageKeys.rules(displayId));
    },
    onError: (error) => { if (isStaleWrite(error)) void refresh(signageKeys.rules(displayId)); },
  });
}

/** The writable settings of a display, to change one of them without touching the rest. */
export const settingsOf = (display: SignageDisplay): Omit<UpdateSignageDisplayRequest, 'expectedVersion'> => ({
  name: display.name, location: display.location, orientation: display.orientation, resolution: display.resolution,
  visibleFromOutside: display.visibleFromOutside, defaultPlaylistId: display.defaultPlaylistId,
});
