import {
  Button,
  CodeSnippet,
  DataTable,
  Form,
  InlineNotification,
  Select,
  SelectItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TextInput,
  Tile,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { PrinterConnector, PrinterConnectorAssignment, PrinterObservedRun } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { listMachines } from '../../api/generated/machines/machines';
import {
  createPrinterConnector,
  createPrinterConnectorAssignment,
  createPrinterConnectorEnrollment,
  linkPrinterObservedRunAttempt,
  listPrinterConnectorAssignments,
  listPrinterConnectorEvents,
  listPrinterConnectors,
  listPrinterObservedRuns,
  revokePrinterConnector,
  updatePrinterConnector,
  updatePrinterConnectorAssignment,
} from '../../api/generated/printer-connectors/printer-connectors';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';

type Status = 'Connected' | 'Disconnected' | 'Degraded' | 'Disabled' | 'Never connected' | 'Pending' | 'Revoked';

function statusOf(connector: PrinterConnector): Status {
  if (connector.lifecycle === 'revoked') return 'Revoked';
  if (connector.lifecycle === 'disabled') return 'Disabled';
  if (connector.lifecycle === 'pending') return 'Pending';
  if (!connector.lastHeartbeatAt) return 'Never connected';
  if (Date.now() - new Date(connector.lastHeartbeatAt).getTime() > 90_000) return 'Disconnected';
  return connector.healthState === 'degraded' ? 'Degraded' : 'Connected';
}

function statusTagType(status: Status): 'green' | 'red' | 'warm-gray' | 'purple' | 'blue' | 'magenta' {
  if (status === 'Connected') return 'green';
  if (status === 'Degraded') return 'purple';
  if (status === 'Disconnected' || status === 'Revoked') return 'red';
  if (status === 'Pending') return 'blue';
  return 'warm-gray';
}

export function PrinterConnectorsPage() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const canManage = hasPermission(currentUser, PermissionId.printer_connectorsmanage);
  const canManageCredentials = hasPermission(currentUser, PermissionId.printer_connectorscredentialsmanage);
  const canAssignMachines = canManage && hasPermission(currentUser, PermissionId.machinesmanage);
  const [creating, setCreating] = useState(false);
  const [assignmentConnector, setAssignmentConnector] = useState<PrinterConnector>();
  const [diagnosticConnector, setDiagnosticConnector] = useState<PrinterConnector>();
  const [enrollmentSecret, setEnrollmentSecret] = useState<string>();
  const query = useQuery({ queryKey: ['printer-connectors'], queryFn: ({ signal }) => listPrinterConnectors({ signal }), refetchInterval: 30_000 });
  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['printer-connectors'] });
  const enrollment = useMutation({
    mutationFn: (connector: PrinterConnector) => createPrinterConnectorEnrollment(connector.id),
    onSuccess: async (issue) => { setEnrollmentSecret(issue.enrollmentSecret); await refresh(); },
  });
  const revoke = useMutation({
    mutationFn: (connector: PrinterConnector) => revokePrinterConnector(connector.id, { expectedVersion: connector.version }),
    onSuccess: refresh,
  });
  const setEnabled = useMutation({
    mutationFn: ({ connector, enabled }: { connector: PrinterConnector; enabled: boolean }) => updatePrinterConnector(connector.id, { name: connector.name, locationLabel: connector.locationLabel, enabled, expectedVersion: connector.version }),
    onSuccess: refresh,
  });
  const headers = [
    { key: 'name', header: 'Connector' },
    { key: 'status', header: 'Status' },
    { key: 'heartbeat', header: 'Last heartbeat' },
    { key: 'version', header: 'Software' },
    { key: 'queue', header: 'Event queue' },
    { key: 'actions', header: 'Actions' },
  ];

  return (
    <PageShell
      title="Printer connectors"
      breadcrumbs={[{ label: 'Settings', to: '/settings' }]}
      description="Manage the outbound agents that observe network printers and deliver normalized events to Core. A heartbeat older than 90 seconds is shown as disconnected."
      actions={canManage ? <Button onClick={() => setCreating(true)}>Add connector</Button> : undefined}
    >
      {enrollmentSecret && <Tile><Stack gap={4}><InlineNotification kind="warning" lowContrast hideCloseButton title="Copy this enrollment secret now" subtitle="It expires after 15 minutes and cannot be retrieved again. Put it in the connector's enrollment secret file."/><CodeSnippet type="multi">{enrollmentSecret}</CodeSnippet><div><Button kind="secondary" onClick={() => setEnrollmentSecret(undefined)}>I have stored the secret</Button></div></Stack></Tile>}
      {(enrollment.isError || revoke.isError || setEnabled.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Connector operation failed" subtitle="Reload the page and try again. The connector may have changed." />}
      {creating && <CreateConnectorForm onCancel={() => setCreating(false)} onCreated={async () => { setCreating(false); await refresh(); }} />}
      {assignmentConnector && <AssignmentForm connector={assignmentConnector} onCancel={() => setAssignmentConnector(undefined)} onCreated={async () => { setAssignmentConnector(undefined); await refresh(); }} />}
      {diagnosticConnector && <DiagnosticsPanel connector={diagnosticConnector} canManage={canAssignMachines} canLink={canManage && hasPermission(currentUser, PermissionId.print_submissionsmanage)} onClose={() => setDiagnosticConnector(undefined)} />}
      {query.isPending && <InlineLoadingState label="Loading printer connectors" />}
      {query.isError && <ErrorState title="Unable to load printer connectors" message="Check the connection and try again." onRetry={() => void query.refetch()} />}
      {query.data?.items.length === 0 && !creating && <Tile><p>No printer connectors are registered.</p></Tile>}
      {query.data && query.data.items.length > 0 && <DataTable rows={query.data.items.map((connector) => ({ id: connector.id, name: connector.locationLabel ? `${connector.name} — ${connector.locationLabel}` : connector.name, status: statusOf(connector), heartbeat: connector.lastHeartbeatAt ? formatDateTime(connector.lastHeartbeatAt) : 'None', version: connector.softwareVersion ?? 'Unknown', queue: `${connector.pendingEventCount} pending / ${connector.quarantinedEventCount} quarantined`, actions: connector.id }))} headers={headers}>{({ rows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => <TableContainer><Table {...getTableProps()}><TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead><TableBody>{rows.map((row) => { const connector = query.data.items.find((item) => item.id === row.id)!; const status = statusOf(connector); return <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'status' ? <Tag type={statusTagType(status)}>{status}</Tag> : cell.info.header === 'actions' ? <Stack orientation="horizontal" gap={3}><Button size="sm" kind="ghost" onClick={() => setDiagnosticConnector(connector)}>Diagnostics</Button>{canManageCredentials && connector.lifecycle === 'pending' && <Button size="sm" kind="ghost" disabled={enrollment.isPending} onClick={() => enrollment.mutate(connector)}>Enroll</Button>}{canManage && (connector.lifecycle === 'active' || connector.lifecycle === 'disabled') && <Button size="sm" kind="ghost" disabled={setEnabled.isPending} onClick={() => setEnabled.mutate({ connector, enabled: connector.lifecycle === 'disabled' })}>{connector.lifecycle === 'disabled' ? 'Enable' : 'Disable'}</Button>}{canAssignMachines && connector.lifecycle !== 'revoked' && <Button size="sm" kind="ghost" onClick={() => setAssignmentConnector(connector)}>Assign printer</Button>}{canManageCredentials && connector.lifecycle !== 'revoked' && <Button size="sm" kind="danger--ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(connector)}>Revoke</Button>}</Stack> : cell.value}</TableCell>)}</TableRow>; })}</TableBody></Table></TableContainer>}</DataTable>}
    </PageShell>
  );
}

function DiagnosticsPanel({ connector, canManage, canLink, onClose }: { connector: PrinterConnector; canManage: boolean; canLink: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const assignments = useQuery({ queryKey: ['printer-connectors', connector.id, 'assignments'], queryFn: ({ signal }) => listPrinterConnectorAssignments(connector.id, { signal }) });
  const events = useQuery({ queryKey: ['printer-connectors', connector.id, 'events'], queryFn: ({ signal }) => listPrinterConnectorEvents(connector.id, { signal }) });
  const runs = useQuery({ queryKey: ['printer-connectors', connector.id, 'observed-runs'], queryFn: ({ signal }) => listPrinterObservedRuns(connector.id, { signal }) });
  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['printer-connectors', connector.id] });
  const updateAssignment = useMutation({
    mutationFn: ({ assignment, enabled, end }: { assignment: PrinterConnectorAssignment; enabled: boolean; end: boolean }) => updatePrinterConnectorAssignment(connector.id, assignment.id, { adapterKind: assignment.adapterKind, adapterSchemaVersion: assignment.adapterSchemaVersion, settings: assignment.settings, enabled, end, expectedVersion: assignment.version }),
    onSuccess: refresh,
  });
  return <Tile><Stack gap={5}><div><h2>{connector.name} diagnostics</h2><p>Configuration revision {connector.appliedConfigurationRevision} of {connector.configurationRevision} applied. Events remain on the connector until Core accepts or identifies them as duplicates.</p></div>{updateAssignment.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Assignment not updated" subtitle="Reload the connector and try again." />}<h3>Printer assignments</h3>{assignments.isPending && <InlineLoadingState label="Loading assignments" />}{assignments.data?.items.length === 0 && <p>No printers assigned.</p>}{assignments.data?.items.map((assignment) => <div key={assignment.id}><strong>{assignment.machineName}</strong><p>{assignment.adapterKind} · configuration {assignment.appliedConfigurationVersion} of {assignment.configurationVersion} · {assignment.runtimeState ?? (assignment.endedAt ? 'ended' : 'not reported')}</p>{assignment.runtimeErrorCode && <p>Error: <code>{assignment.runtimeErrorCode}</code></p>}{canManage && !assignment.endedAt && <Stack orientation="horizontal" gap={3}><Button size="sm" kind="ghost" disabled={updateAssignment.isPending} onClick={() => updateAssignment.mutate({ assignment, enabled: !assignment.enabled, end: false })}>{assignment.enabled ? 'Disable assignment' : 'Enable assignment'}</Button><Button size="sm" kind="danger--ghost" disabled={updateAssignment.isPending} onClick={() => updateAssignment.mutate({ assignment, enabled: false, end: true })}>End assignment</Button></Stack>}</div>)}<h3>Recent observed print runs</h3>{runs.isPending && <InlineLoadingState label="Loading observed runs" />}{runs.data?.items.length === 0 && <p>No physical print runs observed.</p>}{runs.data?.items.map((run) => <ObservedRunRow key={run.id} run={run} canLink={canLink} onLinked={refresh} />)}<h3>Recent normalized events</h3>{events.isPending && <InlineLoadingState label="Loading connector events" />}{events.data?.items.length === 0 && <p>No events received.</p>}{events.data?.items.map((event) => <div key={event.id}><strong>{event.kind.replaceAll('_', ' ')}</strong><p>{formatDateTime(event.receivedAt)} · {event.applicationState.replaceAll('_', ' ')} · reconciliation {event.reconciliationState.replaceAll('_', ' ')}</p>{event.applicationReason && <p>Review reason: <code>{event.applicationReason}</code></p>}<CodeSnippet type="multi" hideCopyButton>{JSON.stringify(event.payload, null, 2)}</CodeSnippet></div>)}<div><Button kind="secondary" onClick={onClose}>Close diagnostics</Button></div></Stack></Tile>;
}

function ObservedRunRow({ run, canLink, onLinked }: { run: PrinterObservedRun; canLink: boolean; onLinked: () => Promise<unknown> }) {
  const [attemptId, setAttemptId] = useState('');
  const mutation = useMutation({ mutationFn: () => linkPrinterObservedRunAttempt(run.id, { attemptId, expectedVersion: run.version }), onSuccess: onLinked });
  return <div><strong>{run.machineName} · {run.state}</strong><p>{run.vendorJobId ?? run.id} · last seen {formatDateTime(run.lastObservedAt)}{run.historyComplete ? '' : ' · incomplete history'}</p>{run.attemptId ? <p>Linked Print Attempt: <code>{run.attemptId}</code></p> : canLink && <Stack orientation="horizontal" gap={3}><TextInput id={`observed-run-attempt-${run.id}`} labelText="Existing Print Attempt ID" value={attemptId} onChange={(event) => setAttemptId(event.target.value.trim())} /><Button size="sm" disabled={!attemptId || mutation.isPending} onClick={() => mutation.mutate()}>Link attempt</Button></Stack>}{mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Run not linked" subtitle="The attempt must exist on the same machine and must not already be linked to another run." />}</div>;
}

function CreateConnectorForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const mutation = useMutation({ mutationFn: () => createPrinterConnector({ name: name.trim(), locationLabel: location.trim() || null }), onSuccess: onCreated });
  const submit = (event: FormEvent) => { event.preventDefault(); mutation.mutate(); };
  return <Tile><Form onSubmit={submit}><Stack gap={5}><h2>Add connector</h2>{mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Connector not created" subtitle="Review the values and try again." />}<TextInput id="printer-connector-name" labelText="Connector name" value={name} required maxLength={120} onChange={(event) => setName(event.target.value)} /><TextInput id="printer-connector-location" labelText="Location (optional)" value={location} maxLength={200} onChange={(event) => setLocation(event.target.value)} /><div className="form-actions"><Button type="button" kind="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={!name.trim() || mutation.isPending}>Create</Button></div></Stack></Form></Tile>;
}

function AssignmentForm({ connector, onCancel, onCreated }: { connector: PrinterConnector; onCancel: () => void; onCreated: () => Promise<unknown> }) {
  const [machineId, setMachineId] = useState('');
  const [scenario, setScenario] = useState('idle');
  const [intervalSeconds, setIntervalSeconds] = useState('5');
  const machines = useQuery({ queryKey: ['machines', 'printer-connector-options'], queryFn: ({ signal }) => listMachines({ page: 1, pageSize: 100 }, { signal }) });
  const mutation = useMutation({ mutationFn: () => createPrinterConnectorAssignment(connector.id, { machineId, adapterKind: 'simulator', adapterSchemaVersion: 1, settings: { scenario, intervalSeconds: Number(intervalSeconds) }, secrets: {} }), onSuccess: onCreated });
  const submit = (event: FormEvent) => { event.preventDefault(); mutation.mutate(); };
  return <Tile><Form onSubmit={submit}><Stack gap={5}><div><h2>Assign a simulated printer</h2><p>The simulator uses the production connector runtime and event ingress path. Real manufacturer adapters can use the same assignment contract later.</p></div>{mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Printer not assigned" subtitle="The machine must have an enabled printer profile and cannot already have an active connector assignment." />}<Select id="printer-connector-machine" labelText="Machine" value={machineId} required onChange={(event) => setMachineId(event.target.value)}><SelectItem value="" text="Select a printer" />{machines.data?.items.map((machine) => <SelectItem key={machine.id} value={machine.id} text={machine.name} />)}</Select><Select id="printer-connector-scenario" labelText="Simulator scenario" value={scenario} onChange={(event) => setScenario(event.target.value)}><SelectItem value="idle" text="Idle"/><SelectItem value="successful_print" text="Successful print"/><SelectItem value="failed_print" text="Failed print"/></Select><TextInput id="printer-connector-interval" labelText="Simulator step interval (seconds)" type="number" min={1} max={3600} value={intervalSeconds} onChange={(event) => setIntervalSeconds(event.target.value)} /><div className="form-actions"><Button type="button" kind="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={!machineId || mutation.isPending}>Assign printer</Button></div></Stack></Form></Tile>;
}
