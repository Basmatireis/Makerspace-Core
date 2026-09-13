import { useRef } from 'react';
import {
  useMutation,
  type UseMutationOptions,
} from '@tanstack/react-query';

type SecretMutationOptions<TData, TError> = Omit<
  UseMutationOptions<TData, TError, void, unknown>,
  'mutationFn'
>;

/**
 * Runs a mutation without placing its secret-bearing input in TanStack Query's
 * persisted mutation variables. The request exists only for the active call and
 * is released as soon as the transport promise settles.
 */
export function useSecretMutation<TSecret, TData, TError = Error>(
  execute: (secret: TSecret) => Promise<TData>,
  options?: SecretMutationOptions<TData, TError>,
) {
  const pendingSecret = useRef<{ value: TSecret } | null>(null);
  const callInProgress = useRef(false);
  const mutation = useMutation<TData, TError, void>({
    ...options,
    mutationFn: async () => {
      const request = pendingSecret.current;
      if (!request) {
        throw new Error('Secret mutation called without an active request');
      }

      try {
        return await execute(request.value);
      } finally {
        pendingSecret.current = null;
      }
    },
  });

  const mutateSecretAsync = async (secret: TSecret): Promise<TData> => {
    if (callInProgress.current) {
      throw new Error('Secret mutation is already in progress');
    }

    callInProgress.current = true;
    pendingSecret.current = { value: secret };
    try {
      return await mutation.mutateAsync();
    } finally {
      pendingSecret.current = null;
      callInProgress.current = false;
    }
  };

  return { ...mutation, mutateAsync: mutateSecretAsync };
}
