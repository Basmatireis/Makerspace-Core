import { useMutation, useQueryClient } from '@tanstack/react-query';
import { confirmOwnLaborordnung } from '../../../api/generated/laborordnung/laborordnung';
import { apiErrorCode } from '../../../api/http-client';
import { authQueryKey } from '../../auth/auth';
import { dashboardKeys } from '../../dashboard/queries';
import { notificationKeys } from '../../notifications/queries';

export function isLabRulesVersionOutdated(error: unknown): boolean {
  return apiErrorCode(error) === 'lab_rules_version_outdated';
}

/**
 * Confirms the given Lab Rules version for the signed-in person. Every place that shows the own status reads from the
 * current-user query or the dashboard query, so both are refreshed; a 409 `lab_rules_version_outdated` means a newer
 * revision became effective while the form was open, so the status is reloaded and the form shows the new revision.
 */
export function useConfirmOwnLabRules() {
  const client = useQueryClient();
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: authQueryKey }),
      client.invalidateQueries({ queryKey: dashboardKeys.labRules() }),
    ]);
  return useMutation({
    mutationFn: (versionId: string) => confirmOwnLaborordnung({ versionId }),
    onSuccess: async () => {
      await refresh();
      // The server marks the "new Lab Rules" notification read in the same transaction.
      await client.invalidateQueries({ queryKey: notificationKeys.all });
    },
    onError: (error) => {
      if (isLabRulesVersionOutdated(error)) void refresh();
    },
  });
}
