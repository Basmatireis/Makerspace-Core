import {
  Button,
  Checkbox,
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
import { useForm } from 'react-hook-form';
import type { PrinterConnector, PrinterConnectorAssignment, PrinterObservedRun } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { listMachines } from '../../api/generated/machines/machines';
import {
  createPrinterConnector,
  createPrinterConnectorAssignment,
  createPrinterConnectorEnrollment,
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
import { connectorDiagnostic, isIPv4Unicast } from './connectorHelpers';

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

const setting = (assignment: PrinterConnectorAssignment, key: string) => typeof assignment.settings[key] === 'string' ? assignment.settings[key] : '';
const numberSetting = (assignment: PrinterConnectorAssignment, key: string, fallback: string) => typeof assignment.settings[key] === 'number' ? String(assignment.settings[key]) : fallback;
const booleanSetting = (assignment: PrinterConnectorAssignment, key: string) => assignment.settings[key] === true;

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
      {diagnosticConnector && <DiagnosticsPanel connector={diagnosticConnector} canManage={canAssignMachines} onClose={() => setDiagnosticConnector(undefined)} />}
      {query.isPending && <InlineLoadingState label="Loading printer connectors" />}
      {query.isError && <ErrorState title="Unable to load printer connectors" message="Check the connection and try again." onRetry={() => void query.refetch()} />}
      {query.data?.items.length === 0 && !creating && <Tile><p>No printer connectors are registered.</p></Tile>}
      {query.data && query.data.items.length > 0 && <DataTable rows={query.data.items.map((connector) => ({ id: connector.id, name: connector.locationLabel ? `${connector.name} — ${connector.locationLabel}` : connector.name, status: statusOf(connector), heartbeat: connector.lastHeartbeatAt ? formatDateTime(connector.lastHeartbeatAt) : 'None', version: connector.softwareVersion ?? 'Unknown', queue: `${connector.pendingEventCount} pending / ${connector.quarantinedEventCount} quarantined`, actions: connector.id }))} headers={headers}>{({ rows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => <TableContainer><Table {...getTableProps()}><TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead><TableBody>{rows.map((row) => { const connector = query.data.items.find((item) => item.id === row.id)!; const status = statusOf(connector); return <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'status' ? <Tag type={statusTagType(status)}>{status}</Tag> : cell.info.header === 'actions' ? <Stack orientation="horizontal" gap={3}><Button size="sm" kind="ghost" onClick={() => setDiagnosticConnector(connector)}>Diagnostics</Button>{canManageCredentials && connector.lifecycle === 'pending' && <Button size="sm" kind="ghost" disabled={enrollment.isPending} onClick={() => enrollment.mutate(connector)}>Enroll</Button>}{canManage && (connector.lifecycle === 'active' || connector.lifecycle === 'disabled') && <Button size="sm" kind="ghost" disabled={setEnabled.isPending} onClick={() => setEnabled.mutate({ connector, enabled: connector.lifecycle === 'disabled' })}>{connector.lifecycle === 'disabled' ? 'Enable' : 'Disable'}</Button>}{canAssignMachines && connector.lifecycle !== 'revoked' && <Button size="sm" kind="ghost" onClick={() => setAssignmentConnector(connector)}>Assign printer</Button>}{canManageCredentials && connector.lifecycle !== 'revoked' && <Button size="sm" kind="danger--ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(connector)}>Revoke</Button>}</Stack> : cell.value}</TableCell>)}</TableRow>; })}</TableBody></Table></TableContainer>}</DataTable>}
    </PageShell>
  );
}

function DiagnosticsPanel({ connector, canManage, onClose }: { connector: PrinterConnector; canManage: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [editingAssignment, setEditingAssignment] = useState<PrinterConnectorAssignment>();
  const assignments = useQuery({ queryKey: ['printer-connectors', connector.id, 'assignments'], queryFn: ({ signal }) => listPrinterConnectorAssignments(connector.id, { signal }) });
  const events = useQuery({ queryKey: ['printer-connectors', connector.id, 'events'], queryFn: ({ signal }) => listPrinterConnectorEvents(connector.id, { signal }) });
  const runs = useQuery({ queryKey: ['printer-connectors', connector.id, 'observed-runs'], queryFn: ({ signal }) => listPrinterObservedRuns(connector.id, { signal }) });
  const refresh = async () => queryClient.invalidateQueries({ queryKey: ['printer-connectors', connector.id] });
  const updateAssignment = useMutation({
    mutationFn: ({ assignment, enabled, end }: { assignment: PrinterConnectorAssignment; enabled: boolean; end: boolean }) => updatePrinterConnectorAssignment(connector.id, assignment.id, { adapterKind: assignment.adapterKind, adapterSchemaVersion: assignment.adapterSchemaVersion, settings: assignment.settings, enabled, end, expectedVersion: assignment.version }),
    onSuccess: refresh,
  });
  return <Tile><Stack gap={5}><div><h2>{connector.name} diagnostics</h2><p>Configuration revision {connector.appliedConfigurationRevision} of {connector.configurationRevision} applied. Events remain on the connector until Core accepts or identifies them as duplicates.</p></div>{connector.healthState === 'degraded' && connector.healthSummary && <InlineNotification kind="warning" lowContrast hideCloseButton title="Connector needs attention" subtitle={`${connectorDiagnostic(connector.healthSummary)} (${connector.healthSummary})`} />}{updateAssignment.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Assignment not updated" subtitle="Reload the connector and try again." />}{editingAssignment && <AssignmentForm connector={connector} assignment={editingAssignment} onCancel={() => setEditingAssignment(undefined)} onCreated={async () => { setEditingAssignment(undefined); await refresh(); }} />}<h3>Printer assignments</h3>{assignments.isPending && <InlineLoadingState label="Loading assignments" />}{assignments.data?.items.length === 0 && <p>No printers assigned.</p>}{assignments.data?.items.map((assignment) => <div key={assignment.id}><strong>{assignment.machineName}</strong><p>{assignment.adapterKind} · configuration {assignment.appliedConfigurationVersion} of {assignment.configurationVersion} · {assignment.runtimeState ?? (assignment.endedAt ? 'ended' : 'not reported')}</p>{assignment.runtimeErrorCode && <InlineNotification kind="warning" lowContrast hideCloseButton title={assignment.runtimeErrorCode} subtitle={connectorDiagnostic(assignment.runtimeErrorCode)} />}{canManage && !assignment.endedAt && <Stack orientation="horizontal" gap={3}><Button size="sm" kind="ghost" onClick={() => setEditingAssignment(assignment)}>Edit settings</Button><Button size="sm" kind="ghost" disabled={updateAssignment.isPending} onClick={() => updateAssignment.mutate({ assignment, enabled: !assignment.enabled, end: false })}>{assignment.enabled ? 'Disable assignment' : 'Enable assignment'}</Button><Button size="sm" kind="danger--ghost" disabled={updateAssignment.isPending} onClick={() => updateAssignment.mutate({ assignment, enabled: false, end: true })}>End assignment</Button></Stack>}</div>)}<h3>Recent observed print runs</h3>{runs.isPending && <InlineLoadingState label="Loading observed runs" />}{runs.data?.items.length === 0 && <p>No physical print runs observed.</p>}{runs.data?.items.map((run) => <ObservedRunRow key={run.id} run={run} />)}<h3>Recent normalized events</h3>{events.isPending && <InlineLoadingState label="Loading connector events" />}{events.data?.items.length === 0 && <p>No events received.</p>}{events.data?.items.map((event) => <div key={event.id}><strong>{event.kind.replaceAll('_', ' ')}</strong><p>{formatDateTime(event.receivedAt)} · {event.applicationState.replaceAll('_', ' ')}</p>{event.applicationReason && <p>Review reason: <code>{event.applicationReason}</code></p>}<CodeSnippet type="multi" hideCopyButton>{JSON.stringify(event.payload, null, 2)}</CodeSnippet></div>)}<div><Button kind="secondary" onClick={onClose}>Close diagnostics</Button></div></Stack></Tile>;
}

function ObservedRunRow({ run }: { run: PrinterObservedRun }) {
  return <div><strong>{run.machineName} · {run.state}</strong><p>{run.vendorJobId ?? run.id} · last seen {formatDateTime(run.lastObservedAt)}{run.historyComplete ? '' : ' · incomplete history'}</p></div>;
}

function CreateConnectorForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => Promise<unknown> }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const mutation = useMutation({ mutationFn: () => createPrinterConnector({ name: name.trim(), locationLabel: location.trim() || null }), onSuccess: onCreated });
  const submit = (event: FormEvent) => { event.preventDefault(); mutation.mutate(); };
  return <Tile><Form onSubmit={submit}><Stack gap={5}><h2>Add connector</h2>{mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Connector not created" subtitle="Review the values and try again." />}<TextInput id="printer-connector-name" labelText="Connector name" value={name} required maxLength={120} onChange={(event) => setName(event.target.value)} /><TextInput id="printer-connector-location" labelText="Location (optional)" value={location} maxLength={200} onChange={(event) => setLocation(event.target.value)} /><div className="form-actions"><Button type="button" kind="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={!name.trim() || mutation.isPending}>Create</Button></div></Stack></Form></Tile>;
}

type AssignmentValues = {
  machineId: string;
  adapterKind: 'simulator' | 'bambu_h2d';
  scenario: string;
  intervalSeconds: string;
  ipAddress: string;
  serialNumber: string;
  lanAccessCode: string;
  autoDetectSpools: boolean;
  enabled: boolean;
};

function AssignmentForm({ connector, assignment, onCancel, onCreated }: { connector: PrinterConnector; assignment?: PrinterConnectorAssignment; onCancel: () => void; onCreated: () => Promise<unknown> }) {
  const editing = Boolean(assignment);
  const machines = useQuery({ queryKey: ['machines', 'printer-connector-options'], queryFn: ({ signal }) => listMachines({ page: 1, pageSize: 100 }, { signal }) });
  const { register, watch, setValue, handleSubmit, formState: { errors } } = useForm<AssignmentValues>({
    defaultValues: {
      machineId: assignment?.machineId ?? '',
      adapterKind: assignment?.adapterKind === 'bambu_h2d' ? 'bambu_h2d' : 'simulator',
      scenario: assignment ? setting(assignment, 'scenario') || 'idle' : 'idle',
      intervalSeconds: assignment ? numberSetting(assignment, 'intervalSeconds', '5') : '5',
      ipAddress: assignment ? setting(assignment, 'ipAddress') : '',
      serialNumber: assignment ? setting(assignment, 'serialNumber') : '',
      lanAccessCode: '',
      autoDetectSpools: assignment ? booleanSetting(assignment, 'autoDetectSpools') : false,
      enabled: assignment?.enabled ?? true,
    },
  });
  const adapterKind = watch('adapterKind');
  const enabled = watch('enabled');
  const mutation = useMutation({
    mutationFn: (values: AssignmentValues) => {
      const settings = values.adapterKind === 'bambu_h2d'
		? { ipAddress: values.ipAddress.trim(), serialNumber: values.serialNumber.trim().toUpperCase(), autoDetectSpools: values.autoDetectSpools }
        : { scenario: values.scenario, intervalSeconds: Number(values.intervalSeconds) };
      const secrets: Record<string, string> = values.adapterKind === 'bambu_h2d' && values.lanAccessCode ? { lanAccessCode: values.lanAccessCode } : {};
      if (assignment) return updatePrinterConnectorAssignment(connector.id, assignment.id, {
        adapterKind: values.adapterKind, adapterSchemaVersion: 1, settings, enabled: values.enabled, end: false, expectedVersion: assignment.version,
        ...(values.lanAccessCode ? { secrets } : {}),
      });
      const request = { machineId: values.machineId, adapterKind: values.adapterKind, adapterSchemaVersion: 1, settings, secrets, enabled: values.enabled };
      return createPrinterConnectorAssignment(connector.id, request);
    },
    onSuccess: onCreated,
  });
  const submit = handleSubmit((values) => mutation.mutate(values));
  return <Tile><Form onSubmit={submit}><Stack gap={5}><div><h2>{editing ? `Edit ${assignment?.machineName ?? 'printer'} assignment` : 'Assign a printer'}</h2><p>{adapterKind === 'bambu_h2d' ? 'The connector observes this H2D over its LAN-only MQTT and FTPS interfaces. It does not send print-control commands.' : 'The simulator exercises the production connector runtime and event-ingress path without a physical printer.'}</p></div>{mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title={editing ? 'Assignment not updated' : 'Printer not assigned'} subtitle="Review the values. The machine must have an enabled printer profile and no other active connector assignment." />}{!editing && <Select id="printer-connector-machine" labelText="Machine" invalid={Boolean(errors.machineId)} invalidText="Select a printer." {...register('machineId', { required: true })}><SelectItem value="" text="Select a printer" />{machines.data?.items.map((machine) => <SelectItem key={machine.id} value={machine.id} text={machine.name} />)}</Select>}<Select id="printer-connector-adapter" labelText="Adapter" disabled={editing} {...register('adapterKind')}><SelectItem value="simulator" text="Simulator"/><SelectItem value="bambu_h2d" text="Bambu Lab H2D"/></Select>{adapterKind === 'simulator' ? <><Select id="printer-connector-scenario" labelText="Simulator scenario" {...register('scenario')}><SelectItem value="idle" text="Idle"/><SelectItem value="successful_print" text="Successful print"/><SelectItem value="failed_print" text="Failed print"/></Select><TextInput id="printer-connector-interval" labelText="Simulator step interval (seconds)" type="number" min={1} max={3600} invalid={Boolean(errors.intervalSeconds)} invalidText="Enter a value from 1 to 3600 seconds." {...register('intervalSeconds', { required: true, min: 1, max: 3600 })} /></> : <><TextInput id="printer-connector-ip" labelText="Printer IPv4 address" placeholder="192.168.1.42" invalid={Boolean(errors.ipAddress)} invalidText="Enter an IPv4 unicast address." {...register('ipAddress', { required: true, validate: isIPv4Unicast })} /><TextInput id="printer-connector-serial" labelText="Printer serial number" invalid={Boolean(errors.serialNumber)} invalidText="Enter the serial number shown by the printer." {...register('serialNumber', { required: true, maxLength: 80, pattern: /^[A-Z0-9][A-Z0-9_-]*$/, onChange: (event) => setValue('serialNumber', String(event.target.value).toUpperCase(), { shouldValidate: true }) })} /><TextInput id="printer-connector-access-code" labelText={editing ? 'New LAN access code (optional)' : 'LAN access code'} helperText={editing ? 'Leave blank to preserve the current code. Enter a value only to rotate it.' : 'Stored encrypted and never returned by Core.'} type="password" autoComplete="new-password" invalid={Boolean(errors.lanAccessCode)} invalidText="Enter the LAN access code." {...register('lanAccessCode', { required: !editing })} /><Checkbox id="printer-connector-auto-spools" labelText="Automatically mount spools identified by exact Bambu RFID" helperText="Only existing Core spools with a matching NFC tag are mounted. Manual conflicts are never replaced." {...register('autoDetectSpools')} /></>}<Checkbox id="printer-connector-assignment-enabled" labelText="Assignment enabled" checked={enabled} onChange={(_event, state) => setValue('enabled', state.checked, { shouldDirty: true })} /><div className="form-actions"><Button type="button" kind="secondary" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={mutation.isPending}>{editing ? 'Save assignment' : 'Assign printer'}</Button></div></Stack></Form></Tile>;
}
