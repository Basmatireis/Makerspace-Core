import { InlineNotification } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getPersonNotificationSettings,
  setPersonNotificationRulePreference,
} from '../../../api/generated/notification-rules/notification-rules';
import { ApiError } from '../../../api/http-client';
import { DetailSection } from '../../../app/DetailSection';
import { ErrorState, InlineLoadingState } from '../../../app/PageState';
import { useNotify } from '../../../app/toasts';
import { ConsentCardsView } from '../../mynotifications/ConsentCards';
import { ReachingRulesView } from '../../mynotifications/ReachingRulesTable';
import '../../mynotifications/mynotifications.scss';
import { peopleKeys } from '../queries';

const personNotificationSettingsKey = (personId: string) =>
  [...peopleKeys.detail(personId), 'notification-settings'] as const;

function personNotificationSettingsOptions(personId: string) {
  return {
    queryKey: personNotificationSettingsKey(personId),
    queryFn: ({ signal }: { signal: AbortSignal }) => getPersonNotificationSettings(personId, { signal }),
  };
}

function failureText(error: unknown): string {
  // The API explains refusals (a required rule, a master's settings, a rule that no longer reaches the person).
  if (error instanceof ApiError && [403, 404, 409, 422].includes(error.status)) return error.message;
  return 'The change was not saved. Check the connection and try again.';
}

/**
 * What a person allows us to send and how central rules reach them, for staff. Consent answers are the person's own
 * and are only shown; with `notification_settings.manage.all` the channels of each rule can be changed for them. The
 * backend enforces both permissions.
 */
export function PersonNotificationsSection({ personId, canManage }: { personId: string; canManage: boolean }) {
  const queryClient = useQueryClient();
  const notify = useNotify();
  const query = useQuery(personNotificationSettingsOptions(personId));
  const refresh = () => queryClient.invalidateQueries({ queryKey: personNotificationSettingsKey(personId) });

  const preference = useMutation({
    mutationFn: (change: { ruleId: string; name: string; inApp: boolean; email: boolean }) =>
      setPersonNotificationRulePreference(personId, change.ruleId, { inApp: change.inApp, email: change.email }),
    onSuccess: (_result, change) => notify({ kind: 'success', title: 'Saved', subtitle: change.name }),
    onSettled: refresh,
  });
  const failure = preference.error;

  return (
    <DetailSection
      title="Notifications"
      description={
        canManage
          ? 'Consent answers are the person’s own. You can change how central rules reach them.'
          : 'What this person allows and how central rules reach them.'
      }
    >
      {query.isPending ? (
        <InlineLoadingState label="Loading notification settings" />
      ) : query.isError ? (
        <ErrorState
          title="Unable to load notification settings"
          message="Check the connection and try again."
          onRetry={() => void query.refetch()}
        />
      ) : (
        <div className="mn-page">
          {failure && (
            <InlineNotification
              kind="error"
              lowContrast
              title="Change not saved"
              subtitle={failureText(failure)}
              onCloseButtonClick={() => {
                preference.reset();
              }}
            />
          )}
          {!query.data.hasAccount && (
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="No account"
              subtitle="This person has no account, so no rules reach them and there are no channel choices. Their consent answers still apply."
            />
          )}
          <ConsentCardsView settings={query.data.settings} subject="person" />
          {query.data.hasAccount && (
            <ReachingRulesView
              settings={query.data.settings}
              subject="person"
              onChange={canManage ? (change) => preference.mutate(change) : undefined}
            />
          )}
        </div>
      )}
    </DetailSection>
  );
}
