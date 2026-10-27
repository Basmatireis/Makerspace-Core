import { queryOptions } from '@tanstack/react-query';
import { listLaborordnungSignatures } from '../../api/generated/laborordnung/laborordnung';
import type { ListLaborordnungSignaturesParams } from '../../api/generated/models';

export const laborordnungKeys = {
  versions: ['laborordnung', 'versions'] as const,
  requests: ['laborordnung', 'requests'] as const,
  signatures: (params: ListLaborordnungSignaturesParams) => ['laborordnung', 'signatures', params] as const,
};

/** Needs `laborordnung.requests.read`. */
export const signaturesQuery = (params: ListLaborordnungSignaturesParams) =>
  queryOptions({
    queryKey: laborordnungKeys.signatures(params),
    queryFn: ({ signal }) => listLaborordnungSignatures(params, { signal }),
  });
