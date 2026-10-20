import { queryOptions } from '@tanstack/react-query';
import { getStreamingGateway, listLocalServiceCameras, listStreamingGateways } from '../../api/generated/local-services/local-services';

export const localServiceKeys = {
  all: ['local-services'] as const,
  gateways: () => [...localServiceKeys.all, 'gateways'] as const,
  gateway: (id: string) => [...localServiceKeys.all, 'gateway', id] as const,
  cameras: () => [...localServiceKeys.all, 'cameras'] as const,
};

// Heartbeats arrive every 30 s; the views poll at the same pace.
export const gatewaysQuery = () => queryOptions({ queryKey: localServiceKeys.gateways(), queryFn: ({ signal }) => listStreamingGateways({ signal }), refetchInterval: 30_000 });
export const gatewayQuery = (id: string) => queryOptions({ queryKey: localServiceKeys.gateway(id), queryFn: ({ signal }) => getStreamingGateway(id, { signal }), refetchInterval: 30_000 });
/** Every camera with its health, across gateways. */
export const camerasQuery = () => queryOptions({ queryKey: localServiceKeys.cameras(), queryFn: ({ signal }) => listLocalServiceCameras({ signal }), refetchInterval: 30_000 });
