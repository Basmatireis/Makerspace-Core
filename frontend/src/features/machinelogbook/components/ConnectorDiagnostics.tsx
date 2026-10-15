import { Fragment, useState, type ReactNode } from 'react';
import {
  Button, CodeSnippet, ComposedModal, DataTable, InlineNotification, Link as CarbonLink, ModalBody, ModalFooter, ModalHeader, ProgressBar, Stack, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper,
  Tab, TabList, TabPanel, TabPanels, Table, TableBody, TableCell, TableContainer, TableExpandedRow, TableExpandHeader, TableExpandRow, TableHead, TableHeader, TableRow, Tabs, Tag,
} from '@carbon/react';
import { WarningAltFilled } from '@carbon/icons-react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type {
  PrinterConnector, PrinterConnectorAssignment, PrinterConnectorEvent, PrinterConnectorEventKind, PrinterLiveStatus, PrinterLiveStatusState, PrinterLiveStatusUnit, PrinterProfile,
} from '../../../api/generated/models';
import { assignmentsQuery, connectorEventsQuery, liveStatusQuery, observedRunsQuery } from '../connectorQueries';
import { printerQuery, spoolsQuery } from '../queries';
import { externalHolderNozzle, nozzleLabel, trayMismatch, type MountedSpool, type Nozzle } from '../printerSetup';
import { ageSeconds, connectorStatus } from '../shared/connectorStatus';
import { connectorDiagnostic } from '../shared/connectorHelpers';
import { groupConnectorEvents } from '../shared/connectorEvents';
import { formatDateTime, formatRelative } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { useCan } from '../shared/useCan';
import { useNow } from '../shared/useNow';
import { DetectedTrayCell } from './DetectedTrayCell';

const STALE_AFTER_SECONDS = 300;
const LIVE_REFRESH_MS = 5000;

const eventLabels: Record<PrinterConnectorEventKind, string> = {
  identity: 'Identity', connectivity: 'Connection', operational_state: 'State change', progress: 'Progress', slot_observation: 'Slot observation',
  consumption_report: 'Material consumption', terminal_outcome: 'Print outcome', printer_error: 'Printer warning', filament_change: 'Filament change',
};
/** Why Core kept an event for review instead of applying it. */
const reviewReasons: Record<string, string> = {
  stale_assignment: 'The assignment had ended or the connector was disabled when the event arrived.',
  configuration_version_mismatch: 'The event was recorded under an older configuration of the assignment.',
  incomplete_run_history: 'The connector joined the print after it started, so the run history is incomplete.',
};
const reviewReason = (reason: string | null) => reason ? reviewReasons[reason] ?? `Needs review (${reason})` : null;
const stateLabels = { recorded: 'Recorded', applied: 'Applied', review_required: 'Needs review' } as const;
const runtimeLabels = { connecting: 'Connecting', connected: 'Connected', disconnected: 'Disconnected', degraded: 'Degraded', disabled: 'Disabled' } as const;
const runtimeTypes = { connecting: 'blue', connected: 'green', disconnected: 'red', degraded: 'purple', disabled: 'gray' } as const;
const runStateMeta: Record<PrinterLiveStatusState, { label: string; type: 'green' | 'blue' | 'purple' | 'gray' | 'cyan' | 'red' }> = {
  idle: { label: 'Idle', type: 'gray' }, preparing: { label: 'Preparing', type: 'blue' }, printing: { label: 'Printing', type: 'green' },
  paused: { label: 'Paused', type: 'purple' }, finished: { label: 'Finished', type: 'cyan' }, failed: { label: 'Failed', type: 'red' }, unknown: { label: 'Unknown', type: 'gray' },
};

function relativeAge(iso: string) {
  const seconds = ageSeconds(iso);
  return seconds < 60 ? `${seconds} s ago` : formatRelative(iso);
}
function durationText(seconds: number) {
  return seconds < 60 ? `${seconds} s` : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`;
}
const remainingText = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
const temperature = (current: number | null, target: number | null) => current == null ? '—' : target ? `${current} / ${target} °C` : `${current} °C`;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><div className="mj-metric__label">{label}</div><div className="mj-diag-value">{children}</div></div>;
}

const EVENT_PAGE_SIZE = 20;

function EventsTable({ events, caption }: { events: PrinterConnectorEvent[]; caption: string }) {
  const [visible, setVisible] = useState(EVENT_PAGE_SIZE);
  const groups = groupConnectorEvents(events);
  const shown = groups.slice(0, visible);
  const rows = shown.map((group) => ({ id: group.id, time: group.newest.receivedAt, label: eventLabels[group.newest.kind], summary: group.summary }));
  const headers = [{ key: 'time', header: 'Received' }, { key: 'label', header: 'Event' }, { key: 'summary', header: 'What happened' }];
  return (
    <Stack gap={3}>
      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getRowProps, getTableProps }) => (
          <TableContainer>
            <Table {...getTableProps()} size="sm" aria-label={caption}>
              <TableHead>
                <TableRow><TableExpandHeader aria-label="Raw payload" />{tableHeaders.map((header) => <TableHeader key={header.key}>{header.header}</TableHeader>)}</TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => {
                  const group = shown.find((item) => item.id === row.id)!;
                  const event = group.newest;
                  const { key, ...rowProps } = getRowProps({ row });
                  return (
                    <Fragment key={key}>
                      <TableExpandRow {...rowProps} aria-label={`Show raw payload of ${eventLabels[event.kind]} at ${formatDateTime(event.receivedAt)}`}>
                        <TableCell>
                          <div className="mj-cell-stack">
                            <span title={formatDateTime(event.receivedAt)}>{relativeAge(event.receivedAt)}</span>
                            {group.count > 1 && <span className="mj-secondary">since {relativeAge(group.oldest.receivedAt)}</span>}
                          </div>
                        </TableCell>
                        <TableCell>{eventLabels[event.kind]}</TableCell>
                        <TableCell>
                          <div className="mj-cell-stack">
                            <span className="mj-inline">{group.summary}{group.count > 1 && <Tag size="sm" type="gray">×{group.count}</Tag>}</span>
                            {event.applicationState !== 'applied' && <span className="mj-secondary">{stateLabels[event.applicationState]}{event.applicationReason ? ` · ${reviewReason(event.applicationReason)}` : ''}</span>}
                          </div>
                        </TableCell>
                      </TableExpandRow>
                      {row.isExpanded && (
                        <TableExpandedRow colSpan={tableHeaders.length + 1}>
                          <CodeSnippet type="multi" feedback="Copied" aria-label="Raw event payload">{JSON.stringify(event.payload, null, 2)}</CodeSnippet>
                        </TableExpandedRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DataTable>
      {groups.length > visible && (
        <div><Button kind="ghost" size="sm" onClick={() => setVisible((count) => count + EVENT_PAGE_SIZE)}>Show older events ({groups.length - visible} more)</Button></div>
      )}
    </Stack>
  );
}

type PrinterView = { assignment: PrinterConnectorAssignment; live: PrinterLiveStatus | null | undefined; stale: boolean; issue: string | null };

function printerIssue(assignment: PrinterConnectorAssignment, live: PrinterLiveStatus | null | undefined, stale: boolean) {
  if (assignment.runtimeErrorCode) return connectorDiagnostic(assignment.runtimeErrorCode);
  const errors = live?.status.errors ?? [];
  if (errors.some((error) => error.sourceFamily === 'print')) return 'The printer reports a print error';
  if (errors.length > 0) return `${errors.length} printer warning${errors.length === 1 ? '' : 's'}`;
  return stale ? 'No recent status' : null;
}

function ConnectorPanel({ connector, views, events, onSelect }: { connector: PrinterConnector; views: PrinterView[]; events: PrinterConnectorEvent[]; onSelect: (machineId: string) => void }) {
  const now = useNow();
  const status = connectorStatus(connector, now);
  const review = events.filter((event) => event.applicationState === 'review_required');
  const failing = views.find((view) => view.assignment.runtimeErrorCode);
  const configured = connector.appliedConfigurationRevision === connector.configurationRevision;
  const facts: [string, ReactNode][] = [
    ['Lifecycle', connector.lifecycle.charAt(0).toUpperCase() + connector.lifecycle.slice(1)],
    ['Health', <Tag key="h" size="sm" type={status.type}>{status.label}</Tag>],
    ['Software', connector.softwareVersion ?? 'Unknown'],
    ['Configuration', `Revision ${connector.appliedConfigurationRevision} of ${connector.configurationRevision} applied${configured ? '' : ' (update pending)'}`],
    ['Last heartbeat', connector.lastHeartbeatAt ? relativeAge(connector.lastHeartbeatAt) : 'Never'],
    ['Event queue', `${connector.pendingEventCount} pending · ${connector.quarantinedEventCount} quarantined`],
  ];
  return (
    <Stack gap={6}>
      {connector.healthState === 'degraded' && connector.lifecycle === 'active' && (
        <InlineNotification
          kind="warning" lowContrast hideCloseButton title="Connector needs attention"
          subtitle={failing ? `${failing.assignment.machineName}: ${failing.issue}` : connector.healthSummary ? connectorDiagnostic(connector.healthSummary) : 'One of its printers reports a problem.'}
        />
      )}
      <StructuredListWrapper isCondensed isFlush aria-label="Connector summary">
        <StructuredListBody>
          {facts.map(([label, value]) => (
            <StructuredListRow key={label}><StructuredListCell noWrap>{label}</StructuredListCell><StructuredListCell>{value}</StructuredListCell></StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      {review.length > 0 && (
        <div>
          <h4 className="mj-group-title">Events that need review</h4>
          <Stack gap={3}>
            {review.map((event) => (
              <InlineNotification key={event.id} kind="warning" lowContrast hideCloseButton title={reviewReason(event.applicationReason) ?? 'Needs review'} subtitle={`${eventLabels[event.kind]} · ${relativeAge(event.receivedAt)}`} />
            ))}
          </Stack>
        </div>
      )}
      <div>
        <h4 className="mj-group-title">Assigned printers</h4>
        {views.length === 0 ? <p className="mj-secondary">No printers assigned. Assign a printer from its setup.</p> : (
          <Table size="sm" aria-label="Assigned printers">
            <TableHead><TableRow>{['Printer', 'Adapter', 'Runtime state', 'Last data', 'Issue'].map((header) => <TableHeader key={header}>{header}</TableHeader>)}</TableRow></TableHead>
            <TableBody>
              {views.map(({ assignment, live, issue }) => (
                <TableRow key={assignment.id}>
                  <TableCell><CarbonLink href="#" onClick={(event) => { event.preventDefault(); onSelect(assignment.machineId); }}>{assignment.machineName}</CarbonLink></TableCell>
                  <TableCell>{assignment.adapterKind === 'bambu_h2d' ? 'Bambu LAN' : 'Simulator'}</TableCell>
                  <TableCell>{assignment.runtimeState ? <Tag size="sm" type={runtimeTypes[assignment.runtimeState]}>{runtimeLabels[assignment.runtimeState]}</Tag> : <span className="mj-secondary">Not reported</span>}</TableCell>
                  <TableCell>{live ? relativeAge(live.receivedAt) : 'None yet'}</TableCell>
                  <TableCell>{issue ?? <span className="mj-secondary">None</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Stack>
  );
}

function MaterialSection({ units, active, profile, spools }: {
  units: PrinterLiveStatusUnit[]; active: PrinterLiveStatus['status']['activeTray']; profile: PrinterProfile | undefined; spools: MountedSpool[];
}) {
  const mapping = (unitExt: string, trayExt: string) => {
    const inputUnit = profile?.inputUnits.find((unit) => unit.enabled && unit.externalIdentifier === unitExt);
    const slot = inputUnit && profile?.slots.find((item) => item.inputUnitId === inputUnit.id && item.status !== 'retired' && item.externalIdentifier === trayExt);
    if (!inputUnit || !slot) return null;
    const mounted: MountedSpool | undefined = slot.spoolId ? spools.find((item) => item.id === slot.spoolId) ?? { id: slot.spoolId, displayId: slot.spoolDisplayId ?? null, materialName: null } : undefined;
    return { inputUnit, slot, spool: mounted };
  };
  const nozzleOf = (unit: PrinterLiveStatusUnit): Nozzle | null => profile?.inputUnits.find((item) => item.externalIdentifier === unit.externalId)?.nozzle ?? (unit.kind === 'external' ? externalHolderNozzle(unit.externalId) : null);
  return (
    <Stack gap={5}>
      {units.map((unit) => {
        const nozzle = nozzleOf(unit);
        return (
          <div key={unit.externalId}>
            <div className="mj-inline">
              <strong>{unit.label}</strong>
              <span className="mj-secondary">
                {[nozzle ? nozzleLabel(nozzle) : null, unit.humidityPercent != null ? `${unit.humidityPercent} % humidity` : null, unit.temperatureC != null ? `${unit.temperatureC} °C` : null].filter(Boolean).join(' · ')}
              </span>
            </div>
            <Table size="sm" className="mj-diag-trays" aria-label={`${unit.label} trays`}>
              <TableHead>
                <TableRow><TableHeader>Printer slot</TableHeader><TableHeader>Reported</TableHeader><TableHeader>Core slot</TableHeader><TableHeader>Mounted spool</TableHeader><TableHeader>Status</TableHeader></TableRow>
              </TableHead>
              <TableBody>
                {unit.trays.map((tray, index) => {
                  const feeding = active?.unitExternalId === unit.externalId && active.trayExternalId === tray.externalId;
                  const mapped = mapping(unit.externalId, tray.externalId);
                  const issue = mapped ? trayMismatch(tray, mapped.spool) : null;
                  return (
                    <TableRow key={tray.externalId}>
                      <TableCell>{unit.kind === 'external' ? 'Spool' : `Slot ${index + 1}`}</TableCell>
                      <TableCell><DetectedTrayCell tray={tray} /></TableCell>
                      <TableCell>{mapped ? `${mapped.inputUnit.name} · ${mapped.slot.name}` : <span className="mj-secondary">Not mapped</span>}</TableCell>
                      <TableCell>{mapped?.spool ? <CarbonLink as={Link} to={machineLogbookPaths.spool(mapped.spool.id)}>{mapped.spool.displayId ?? 'Spool'}</CarbonLink> : <span className="mj-secondary">—</span>}</TableCell>
                      <TableCell>
                        <span className="mj-inline">
                          {feeding && <Tag size="sm" type="green">Feeding now</Tag>}
                          {issue && <Tag size="sm" type="warm-gray" renderIcon={WarningAltFilled}>{issue}</Tag>}
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        );
      })}
    </Stack>
  );
}

function PrinterPanel({ view, events, active }: { view: PrinterView; events: PrinterConnectorEvent[]; active: boolean }) {
  const can = useCan();
  const { assignment } = view;
  const machineId = assignment.machineId;
  // Only the visible printer is polled; the others keep what the connector tab already loaded.
  const liveQuery = useQuery({ ...liveStatusQuery(machineId), enabled: active, refetchInterval: active ? LIVE_REFRESH_MS : false });
  const profileQuery = useQuery({ ...printerQuery(machineId), enabled: active, retry: false });
  const profile = profileQuery.data;
  const canReadInventory = can('inventory.read');
  const mountedSpools = useQuery({ ...spoolsQuery({ mounted: true, pageSize: 100 }), enabled: active && canReadInventory && Boolean(profile?.slots.some((slot) => slot.spoolId)) });
  const runs = useQuery({ ...observedRunsQuery(assignment.connectorId), enabled: active });
  const spools: MountedSpool[] = (mountedSpools.data?.items ?? []).map((spool) => ({ id: spool.id, displayId: spool.displayId, materialName: spool.materialName ?? null }));
  const live = liveQuery.data === undefined ? view.live : liveQuery.data;
  const errorCode = assignment.runtimeErrorCode;
  const stale = Boolean(live && (ageSeconds(live.receivedAt) > STALE_AFTER_SECONDS || assignment.runtimeState === 'degraded'));
  const printerRuns = (runs.data?.items ?? []).filter((run) => run.machineId === machineId).slice(0, 5);
  const eventsTable = events.length === 0 ? <p className="mj-secondary">No events received for this printer.</p> : <EventsTable events={events} caption={`${assignment.machineName} events`} />;

  if (!live) {
    return (
      <Stack gap={5}>
        <InlineNotification kind="info" lowContrast hideCloseButton title="No status received yet" subtitle={errorCode ? connectorDiagnostic(errorCode) : 'This printer has not reported any data to the connector.'} />
        {events.length > 0 && eventsTable}
      </Stack>
    );
  }
  const snapshot = live.status;
  const run = runStateMeta[snapshot.state];
  const job = snapshot.job;
  const jobLabel = job ? [
    job.progressPercent != null ? `${job.progressPercent} %` : null,
    job.layer != null && job.totalLayers != null ? `layer ${job.layer} of ${job.totalLayers}` : null,
    job.remainingMinutes != null ? `about ${remainingText(job.remainingMinutes)} left` : null,
  ].filter(Boolean).join(' · ') : '';
  const nozzleName = (side: Nozzle | null, id: number, total: number) => total > 1 ? (side ? nozzleLabel(side) : `Extruder ${id}`) : 'Nozzle';
  return (
    <Stack gap={6}>
      <div className="mj-inline">
        <Tag size="sm" type={stale ? 'warm-gray' : 'green'}>{stale ? 'Status outdated' : 'Live'}</Tag>
        <span>Last status {relativeAge(live.receivedAt)}</span>
      </div>
      {stale && (
        <InlineNotification
          kind="warning" lowContrast hideCloseButton
          title={`No status for ${durationText(ageSeconds(live.receivedAt))}${errorCode ? ` · ${errorCode}` : ''}`}
          subtitle={errorCode ? `${connectorDiagnostic(errorCode)} Values below are the last known ones.` : 'Check that the printer is on and LAN only mode is enabled. Values below are the last known ones.'}
        />
      )}
      <div>
        <h4 className="mj-group-title">Current job</h4>
        <Stack gap={3}>
          <div className="mj-inline">
            <Tag size="sm" type={run.type}>{run.label}</Tag>
            {job?.fileName ? <strong>{job.fileName}</strong> : <span className="mj-secondary">{snapshot.state === 'idle' ? 'Idle, no active job' : 'No active job'}</span>}
          </div>
          {job?.progressPercent != null && <ProgressBar value={job.progressPercent} max={100} size="small" status={snapshot.state === 'failed' ? 'error' : 'active'} label={jobLabel} />}
        </Stack>
      </div>
      <div>
        <h4 className="mj-group-title">Temperatures</h4>
        <div className="mj-diag-grid">
          {[...snapshot.temperatures.extruders].sort((a, b) => a.extruderId - b.extruderId).map((nozzle) => (
            <Fact key={nozzle.extruderId} label={nozzleName(nozzle.side, nozzle.extruderId, snapshot.temperatures.extruders.length)}>{temperature(nozzle.currentC, nozzle.targetC)}</Fact>
          ))}
          <Fact label="Bed">{temperature(snapshot.temperatures.bedC, snapshot.temperatures.bedTargetC)}</Fact>
          {snapshot.temperatures.chamberC != null && <Fact label="Chamber">{snapshot.temperatures.chamberC} °C</Fact>}
        </div>
      </div>
      {snapshot.units.length > 0 ? (
        <div><h4 className="mj-group-title">Material</h4><MaterialSection units={snapshot.units} active={snapshot.activeTray} profile={profile} spools={spools} /></div>
      ) : (profile?.slots.filter((slot) => slot.status !== 'retired').length ?? 0) > 0 && (
        <div>
          <h4 className="mj-group-title">Material</h4>
          <Stack gap={2}>
            {profile!.slots.filter((slot) => slot.status !== 'retired').map((slot) => (
              <span key={slot.id}>{slot.inputUnitName} · {slot.name}: {slot.spoolId ? `${slot.spoolDisplayId ?? 'Spool'} mounted` : <span className="mj-secondary">no spool mounted</span>}</span>
            ))}
          </Stack>
        </div>
      )}
      <div>
        <h4 className="mj-group-title">Health</h4>
        {snapshot.errors.length === 0 ? <p className="mj-secondary">No errors reported.</p> : (
          <Stack gap={3}>
            {snapshot.errors.map((error) => (
              <span key={`${error.sourceFamily}-${error.code}`} className="mj-inline">
                <Tag size="sm" type={error.sourceFamily === 'print' ? 'red' : 'purple'}>{error.sourceFamily === 'print' ? 'Print error' : 'Warning'}</Tag>
                <code>{error.code}</code>
                {error.observedAt && <span className="mj-secondary">{relativeAge(error.observedAt)}</span>}
              </span>
            ))}
          </Stack>
        )}
      </div>
      <div>
        <h4 className="mj-group-title">Device</h4>
        <div className="mj-diag-grid">
          <Fact label="Firmware">{snapshot.firmwareVersion ?? 'Unknown'}</Fact>
          {[...snapshot.nozzles].sort((a, b) => a.extruderId - b.extruderId).map((nozzle) => (
            <Fact key={nozzle.extruderId} label={nozzleName(nozzle.side, nozzle.extruderId, snapshot.nozzles.length)}>
              {[nozzle.diameterMm != null ? `${nozzle.diameterMm} mm` : null, nozzle.type].filter(Boolean).join(' · ') || 'Unknown'}
            </Fact>
          ))}
          {snapshot.wifiSignalDbm != null && <Fact label="Wi-Fi signal">{snapshot.wifiSignalDbm} dBm</Fact>}
        </div>
      </div>
      {printerRuns.length > 0 && (
        <div>
          <h4 className="mj-group-title">Observed print runs</h4>
          <Stack gap={2}>
            {printerRuns.map((item) => <span key={item.id}>{item.vendorJobId ?? item.id} · {item.state} <span className="mj-secondary">last seen {relativeAge(item.lastObservedAt)}{item.historyComplete ? '' : ' · incomplete history'}</span></span>)}
          </Stack>
        </div>
      )}
      <div>
        <h4 className="mj-group-title">Recent events</h4>
        {eventsTable}
      </div>
    </Stack>
  );
}

export function DiagnosticsModal({ connector, onClose }: { connector: PrinterConnector; onClose: () => void }) {
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const now = useNow();
  const status = connectorStatus(connector, now);
  const assignments = useQuery({ ...assignmentsQuery(connector.id), refetchInterval: 10_000 });
  const events = useQuery({ ...connectorEventsQuery(connector.id), refetchInterval: 10_000 });
  const active = (assignments.data?.items ?? []).filter((assignment) => !assignment.endedAt);
  const liveQueries = useQueries({ queries: active.map((assignment) => ({ ...liveStatusQuery(assignment.machineId), refetchInterval: 15_000 })) });
  const views: PrinterView[] = active.map((assignment, position) => {
    const live = liveQueries[position]?.data;
    const stale = Boolean(live && (ageSeconds(live.receivedAt, now) > STALE_AFTER_SECONDS || assignment.runtimeState === 'degraded'));
    return { assignment, live, stale, issue: printerIssue(assignment, live, stale) };
  });
  const allEvents = events.data?.items ?? [];
  const selected = index > 0 ? views[index - 1] : undefined;
  return (
    <ComposedModal open size="lg" onClose={onClose} aria-label={`${connector.name} diagnostics`}>
      <ModalHeader label="Connector diagnostics" title={<span className="mj-inline">{connector.name}<Tag size="sm" type={status.type}>{status.label}</Tag></span>}>
        <p className="mj-secondary">{[connector.locationLabel, connector.softwareVersion ? `software ${connector.softwareVersion}` : null, `last heartbeat ${connector.lastHeartbeatAt ? relativeAge(connector.lastHeartbeatAt) : 'never'}`].filter(Boolean).join(' · ')}</p>
      </ModalHeader>
      <ModalBody>
        {(assignments.isError || events.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Diagnostics could not be loaded" subtitle="Close the dialog and try again." />}
        <Tabs selectedIndex={Math.min(index, views.length)} onChange={({ selectedIndex }) => setIndex(selectedIndex)}>
          <TabList aria-label="Diagnostics sections" contained>
            <Tab>Connector</Tab>
            {views.map((view) => <Tab key={view.assignment.id} renderIcon={view.issue ? WarningAltFilled : undefined}>{view.assignment.machineName}</Tab>)}
          </TabList>
          <TabPanels>
            <TabPanel><ConnectorPanel connector={connector} views={views} events={allEvents} onSelect={(machineId) => setIndex(views.findIndex((view) => view.assignment.machineId === machineId) + 1)} /></TabPanel>
            {views.map((view, position) => (
              <TabPanel key={view.assignment.id}>
                <PrinterPanel view={view} events={allEvents.filter((event) => event.machineId === view.assignment.machineId)} active={index === position + 1} />
              </TabPanel>
            ))}
          </TabPanels>
        </Tabs>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>Close</Button>
        {selected && <Button kind="primary" onClick={() => { onClose(); navigate(machineLogbookPaths.machine(selected.assignment.machineId, 'printer')); }}>Open printer setup</Button>}
      </ModalFooter>
    </ComposedModal>
  );
}
