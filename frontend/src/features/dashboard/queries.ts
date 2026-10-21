import { queryOptions } from '@tanstack/react-query';
import { getPersonalDashboard } from '../../api/generated/dashboard/dashboard';
import { getOwnLaborordnungStatus } from '../../api/generated/laborordnung/laborordnung';
import { listPublicOpenDays } from '../../api/generated/public-open-days/public-open-days';

export const dashboardKeys = {
  all: ['dashboard'] as const,
  personal: () => [...dashboardKeys.all, 'me'] as const,
  labRules: () => [...dashboardKeys.all, 'lab-rules'] as const,
  publicOpenDays: () => [...dashboardKeys.all, 'public-open-days'] as const,
};

export const personalDashboardOptions = queryOptions({
  queryKey: dashboardKeys.personal(),
  queryFn: ({ signal }) => getPersonalDashboard({ signal }),
});

export const ownLabRulesOptions = queryOptions({
  queryKey: dashboardKeys.labRules(),
  queryFn: ({ signal }) => getOwnLaborordnungStatus({ signal }),
});

export const publicOpenDaysOptions = queryOptions({
  queryKey: dashboardKeys.publicOpenDays(),
  queryFn: ({ signal }) => listPublicOpenDays({ signal }),
});
