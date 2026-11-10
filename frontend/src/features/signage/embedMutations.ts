import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SignageWebEmbed, UpdateSignageWebEmbedRequest } from '../../api/generated/models';
import { updateSignageWebEmbed } from '../../api/generated/signage/signage';
import { isStaleWrite } from './helpers';
import { signageKeys } from './queries';

/** Refreshes everything that depends on an embed's drafts: the embed (version, pending changes), the list and the preview. */
export function useRefreshEmbed(embedId: string) {
  const queryClient = useQueryClient();
  return (...extra: (readonly unknown[])[]) =>
    Promise.all(
      [
        signageKeys.embed(embedId),
        signageKeys.embeds(),
        signageKeys.groups(),
        signageKeys.preview(embedId),
        ...extra,
      ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
}

/** Settings writes quote the embed version; rule writes share it, so a settings write refreshes the rule list's version too. */
export function useUpdateEmbed(embedId: string) {
  const queryClient = useQueryClient();
  const refresh = useRefreshEmbed(embedId);
  return useMutation({
    mutationFn: (request: UpdateSignageWebEmbedRequest) => updateSignageWebEmbed(embedId, request),
    onSuccess: async (updated: SignageWebEmbed) => {
      const before = queryClient.getQueryData<SignageWebEmbed>(signageKeys.embed(embedId));
      queryClient.setQueryData(signageKeys.embed(embedId), updated);
      // The old and the new group list this embed as a member and own the rules it plays.
      const groupIds = new Set([before?.groupId, updated.groupId].filter((id): id is string => Boolean(id)));
      await refresh(
        signageKeys.rules(embedId),
        ...[...groupIds].flatMap((id) => [
          signageKeys.group(id),
          signageKeys.groupRules(id),
          signageKeys.groupPreview(id),
        ]),
      );
    },
    onError: (error) => {
      if (isStaleWrite(error)) void refresh(signageKeys.rules(embedId));
    },
  });
}
