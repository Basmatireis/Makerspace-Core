import { useCallback, useEffect, useRef, useState } from 'react';
import type { PrinterConnector, PrinterConnectorAssignment, PrinterLiveStatus } from '../../../../api/generated/models';
import {
  createPrinterConnectorAssignment, listPrinterConnectorAssignments, updatePrinterConnectorAssignment,
} from '../../../../api/generated/printer-connectors/printer-connectors';
import { fetchLiveStatus, type PrinterConnection } from '../../connectorQueries';
import type { AdapterKind } from './wizardTypes';

/** Poll interval and give-up time of the connection test. Mutable so tests do not have to wait for the real timings. */
export const connectionTestTiming = { pollMs: 2000, timeoutMs: 90_000 };

export type TestPhase = 'idle' | 'saving' | 'config' | 'status' | 'success' | 'timeout' | 'failed';
export type TestState = {
  phase: TestPhase;
  connectorName?: string;
  /** Runtime error code the connector reported for the assignment while the test ran. */
  errorCode?: string | null;
  live?: PrinterLiveStatus;
};

export type AssignmentInput = {
  machineId: string;
  connector: PrinterConnector;
  existing: PrinterConnection | undefined;
  adapterKind: AdapterKind;
  settings: Record<string, string | number | boolean>;
  /** Only sent when the user typed a new LAN access code. */
  secrets: Record<string, string>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

/** Creates or updates the printer's connector assignment (ending one on another connector first). Resolves with the saved assignment. */
export async function saveAssignment({ machineId, connector, existing, adapterKind, settings, secrets }: AssignmentInput): Promise<PrinterConnectorAssignment> {
  const sameConnector = existing && existing.connector.id === connector.id;
  if (existing && !sameConnector) {
    const old = existing.assignment;
    await updatePrinterConnectorAssignment(existing.connector.id, old.id, {
      adapterKind: old.adapterKind, adapterSchemaVersion: old.adapterSchemaVersion, settings: old.settings, enabled: false, end: true, expectedVersion: old.version,
    });
  }
  if (existing && sameConnector) {
    const current = existing.assignment;
    return updatePrinterConnectorAssignment(connector.id, current.id, {
      adapterKind, adapterSchemaVersion: 1, settings, enabled: true, end: false, expectedVersion: current.version,
      ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
    });
  }
  return createPrinterConnectorAssignment(connector.id, { machineId, adapterKind, adapterSchemaVersion: 1, settings, secrets, enabled: true });
}

/**
 * "Save and test": saves the assignment, then waits for the connector to pick the configuration up and report a status
 * snapshot for the printer. Core cannot reach printers itself, so the test succeeds when a fresh snapshot arrives.
 */
export function useConnectionTest() {
  const [state, setState] = useState<TestState>({ phase: 'idle' });
  const run = useRef(0);
  useEffect(() => () => { run.current += 1; }, []);

  // Stable identity: the setup wizard lists reset as an effect dependency.
  const reset = useCallback(() => { run.current += 1; setState({ phase: 'idle' }); }, []);

  const start = async (input: AssignmentInput, onSaved?: (assignment: PrinterConnectorAssignment) => void): Promise<{ assignment: PrinterConnectorAssignment; live?: PrinterLiveStatus }> => {
    const id = ++run.current;
    const current = () => run.current === id;
    setState({ phase: 'saving', connectorName: input.connector.name });
    const previous = await fetchLiveStatus(input.machineId).catch(() => null);
    let assignment: PrinterConnectorAssignment;
    try {
      assignment = await saveAssignment(input);
    } catch (error) {
      if (current()) setState({ phase: 'failed', connectorName: input.connector.name });
      throw error;
    }
    onSaved?.(assignment);
    const deadline = Date.now() + connectionTestTiming.timeoutMs;
    let errorCode: string | null = null;
    let configured = false;
    while (current()) {
      const [live, list] = await Promise.all([
        fetchLiveStatus(input.machineId).catch(() => undefined),
        listPrinterConnectorAssignments(input.connector.id).catch(() => undefined),
      ]);
      if (!current()) break;
      const latest = list?.items.find((item) => item.id === assignment.id);
      if (latest) {
        assignment = latest;
        configured = latest.appliedConfigurationVersion >= latest.configurationVersion;
        errorCode = latest.runtimeErrorCode;
      }
      const fresh = live && live.assignmentId === assignment.id && (!previous || previous.assignmentId !== assignment.id || previous.receivedAt !== live.receivedAt);
      if (fresh) {
        setState({ phase: 'success', connectorName: input.connector.name, live });
        return { assignment, live };
      }
      if (Date.now() >= deadline) {
        setState({ phase: 'timeout', connectorName: input.connector.name, errorCode });
        return { assignment };
      }
      setState({ phase: configured ? 'status' : 'config', connectorName: input.connector.name, errorCode });
      await sleep(connectionTestTiming.pollMs);
    }
    return { assignment };
  };

  return { state, start, reset };
}
