import { queryOptions, useQueries, useQuery } from '@tanstack/react-query';
import type { PrinterConnector, PrinterConnectorAssignment } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { getPrinterLiveStatus } from '../../api/generated/printing/printing';
import {
  listPrinterConnectorAssignments,
  listPrinterConnectorEvents,
  listPrinterConnectors,
  listPrinterObservedRuns,
} from '../../api/generated/printer-connectors/printer-connectors';
import { machineLogbookKeys } from './queries';

export const connectorKeys = {
  all: ['printer-connectors'] as const,
  assignments: (connectorId: string) => ['printer-connectors', connectorId, 'assignments'] as const,
  events: (connectorId: string, includeCleared = false) =>
    ['printer-connectors', connectorId, 'events', includeCleared] as const,
  runs: (connectorId: string) => ['printer-connectors', connectorId, 'observed-runs'] as const,
};

export const connectorsQuery = () =>
  queryOptions({ queryKey: connectorKeys.all, queryFn: ({ signal }) => listPrinterConnectors({ signal }) });
export const assignmentsQuery = (connectorId: string) =>
  queryOptions({
    queryKey: connectorKeys.assignments(connectorId),
    queryFn: ({ signal }) => listPrinterConnectorAssignments(connectorId, { signal }),
  });
export const connectorEventsQuery = (connectorId: string, includeCleared = false) =>
  queryOptions({
    queryKey: connectorKeys.events(connectorId, includeCleared),
    queryFn: ({ signal }) =>
      listPrinterConnectorEvents(connectorId, includeCleared ? { includeCleared: true } : undefined, { signal }),
  });
export const observedRunsQuery = (connectorId: string) =>
  queryOptions({
    queryKey: connectorKeys.runs(connectorId),
    queryFn: ({ signal }) => listPrinterObservedRuns(connectorId, { signal }),
  });

/** The last status snapshot a connector reported for a printer. `null` while none was received (the API answers 404). */
export async function fetchLiveStatus(machineId: string, signal?: AbortSignal) {
  try {
    return await getPrinterLiveStatus(machineId, { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
export const liveStatusKey = (machineId: string) => [...machineLogbookKeys.all, 'live-status', machineId] as const;
export const liveStatusQuery = (machineId: string) =>
  queryOptions({ queryKey: liveStatusKey(machineId), queryFn: ({ signal }) => fetchLiveStatus(machineId, signal) });

export type PrinterConnection = { connector: PrinterConnector; assignment: PrinterConnectorAssignment };

/** The connector and active assignment that observe a printer. Needs printer_connectors.read; `enabled` gates every request. */
export function usePrinterConnection(machineId: string, enabled: boolean, refetchInterval?: number) {
  const connectors = useQuery({ ...connectorsQuery(), enabled, refetchInterval });
  const candidates = (connectors.data?.items ?? []).filter((connector) => connector.lifecycle !== 'revoked');
  const assignments = useQueries({
    queries: candidates.map((connector) => ({ ...assignmentsQuery(connector.id), enabled, refetchInterval })),
  });
  const connection = candidates.flatMap((connector, index): PrinterConnection[] => {
    const assignment = assignments[index]?.data?.items.find((item) => item.machineId === machineId && !item.endedAt);
    return assignment ? [{ connector, assignment }] : [];
  })[0];
  const pending = enabled && (connectors.isPending || assignments.some((result) => result.isPending));
  return {
    connection,
    connectors: connectors.data?.items ?? [],
    pending,
    error: connectors.isError || assignments.some((result) => result.isError),
  };
}
