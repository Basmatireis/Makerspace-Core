import { InlineNotification } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage } from './helpers';
import { signageKeys } from './queries';

/**
 * Duplicates a scene, announcement template or custom layout. The lists are refreshed and `onCopied` receives the copy
 * (the pages open it). `error` is a notification to render near the list when the copy failed.
 */
export function useDuplicate<T>(duplicate: (id: string) => Promise<T>, onCopied: (copy: T) => void) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: duplicate,
    onSuccess: async (copy) => {
      await queryClient.invalidateQueries({ queryKey: signageKeys.all });
      onCopied(copy);
    },
  });
  const error = mutation.isError ? (
    <InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title="The copy could not be created."
      subtitle={errorMessage(mutation.error)}
    />
  ) : null;
  return { duplicate: (id: string) => mutation.mutate(id), pending: mutation.isPending, error };
}
