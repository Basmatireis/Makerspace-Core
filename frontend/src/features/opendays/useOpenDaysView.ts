import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listMyAccountPreferences,
  updateMyAccountPreference,
} from '../../api/generated/account-preferences/account-preferences';
import { AccountPreferenceKey, type AccountPreferenceList } from '../../api/generated/models';
import type { ScheduleView } from './components/ScheduleToolbar';

const preferencesKey = ['account-preferences'] as const;
const openDaysView = AccountPreferenceKey.AccountPreferenceKeyOpenDaysView;

/**
 * The List/Calendar choice of every open-day page. It is stored on the signed-in account (not in browser storage), so
 * it is restored on every device. The page shows the list until the stored value arrives; a change shows at once and
 * is rolled back when the server refuses it.
 */
export function useOpenDaysView(): [ScheduleView, (next: ScheduleView) => void] {
  const queryClient = useQueryClient();
  const preferences = useQuery({
    queryKey: preferencesKey,
    queryFn: ({ signal }) => listMyAccountPreferences({ signal }),
  });
  const save = useMutation({
    mutationFn: (next: ScheduleView) => updateMyAccountPreference(openDaysView, { value: next }),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: preferencesKey });
      const previous = queryClient.getQueryData<AccountPreferenceList>(preferencesKey);
      const others = previous?.items.filter((item) => item.key !== openDaysView) ?? [];
      queryClient.setQueryData<AccountPreferenceList>(preferencesKey, {
        items: [...others, { key: openDaysView, value: next, updatedAt: new Date().toISOString() }],
      });
      return { previous };
    },
    onError: (_error, _next, context) => {
      queryClient.setQueryData(preferencesKey, context?.previous);
    },
  });
  const stored = preferences.data?.items.find((item) => item.key === openDaysView)?.value;
  return [stored === 'calendar' ? 'calendar' : 'list', save.mutate];
}
