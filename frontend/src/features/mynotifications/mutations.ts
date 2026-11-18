import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { NotificationSettings } from '../../api/generated/models';
import {
  answerOwnNotificationConsents,
  setOwnNotificationRulePreference,
} from '../../api/generated/notification-rules/notification-rules';
import { useNotify } from '../../app/toasts';
import { authQueryKey } from '../auth/auth';
import { myNotificationKeys } from './queries';

/** Writes `change` into the cached settings at once and returns what to restore if the request fails. */
function useOptimisticSettings() {
  const queryClient = useQueryClient();
  return async (change: (settings: NotificationSettings) => NotificationSettings) => {
    await queryClient.cancelQueries({ queryKey: myNotificationKeys.settings() });
    const previous = queryClient.getQueryData<NotificationSettings>(myNotificationKeys.settings());
    if (previous) queryClient.setQueryData(myNotificationKeys.settings(), change(previous));
    return { previous };
  };
}

type Rollback = { previous?: NotificationSettings };

/** One consent changed on the profile page: the answer is saved at once and the rules that reach the person refresh. */
export function useChangeConsent() {
  const queryClient = useQueryClient();
  const notify = useNotify();
  const optimistic = useOptimisticSettings();
  return useMutation({
    mutationFn: (answer: { categoryId: string; granted: boolean; name: string }) =>
      answerOwnNotificationConsents({
        answers: [{ categoryId: answer.categoryId, granted: answer.granted }],
        place: 'profile',
      }),
    onMutate: (answer) =>
      optimistic((settings) => ({
        ...settings,
        consents: settings.consents.map((entry) =>
          entry.categoryId === answer.categoryId ? { ...entry, granted: answer.granted } : entry,
        ),
      })),
    onSuccess: (settings, answer) => {
      queryClient.setQueryData(myNotificationKeys.settings(), settings);
      void queryClient.invalidateQueries({ queryKey: authQueryKey });
      notify({
        kind: 'success',
        title: answer.granted ? `${answer.name} allowed` : `${answer.name} not allowed`,
      });
    },
    onError: (_error, _answer, rollback?: Rollback) => {
      if (rollback?.previous) queryClient.setQueryData(myNotificationKeys.settings(), rollback.previous);
      notify({ kind: 'error', title: 'Your answer was not saved', subtitle: 'Check the connection and try again.' });
    },
  });
}

/** The channels a person wants a rule on: the rule's own channels stay the default until they choose. */
export function useChangeRulePreference() {
  const queryClient = useQueryClient();
  const notify = useNotify();
  const optimistic = useOptimisticSettings();
  return useMutation({
    mutationFn: (change: { ruleId: string; name: string; inApp: boolean; email: boolean }) =>
      setOwnNotificationRulePreference(change.ruleId, { inApp: change.inApp, email: change.email }),
    onMutate: (change) =>
      optimistic((settings) => ({
        ...settings,
        rules: settings.rules.map((rule) =>
          rule.ruleId === change.ruleId
            ? {
                ...rule,
                effectiveChannels: [
                  ...rule.effectiveChannels.filter((channel) => channel !== 'in_app' && channel !== 'email'),
                  ...(change.inApp ? ['in_app'] : []),
                  ...(change.email ? ['email'] : []),
                ],
              }
            : rule,
        ),
      })),
    onSuccess: (_result, change) =>
      notify({
        kind: 'success',
        title: change.inApp || change.email ? 'Saved' : 'Muted for you',
        subtitle: change.name,
      }),
    onError: (_error, _change, rollback?: Rollback) => {
      if (rollback?.previous) queryClient.setQueryData(myNotificationKeys.settings(), rollback.previous);
      notify({ kind: 'error', title: 'Your choice was not saved', subtitle: 'Check the connection and try again.' });
    },
    // The server decides what finally reaches the person.
    onSettled: () => queryClient.invalidateQueries({ queryKey: myNotificationKeys.settings() }),
  });
}
