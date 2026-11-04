import { queryOptions } from '@tanstack/react-query';
import { listLaborordnungConfirmations } from '../../api/generated/laborordnung/laborordnung';
import type { ListLaborordnungConfirmationsParams } from '../../api/generated/models';

export const laborordnungKeys = {
  versions: ['laborordnung', 'versions'] as const,
  confirmations: (params: ListLaborordnungConfirmationsParams) => ['laborordnung', 'confirmations', params] as const,
};

/** Needs `laborordnung.confirmations.read`. */
export const confirmationsQuery = (params: ListLaborordnungConfirmationsParams) =>
  queryOptions({
    queryKey: laborordnungKeys.confirmations(params),
    queryFn: ({ signal }) => listLaborordnungConfirmations(params, { signal }),
  });

export const confirmationMethodLabels = {
  app: 'App',
  kiosk: 'Kiosk',
  enrollment: 'Enrollment',
  paper: 'Paper',
} as const;
