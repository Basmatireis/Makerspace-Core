import { Fragment, useState, type ReactNode } from 'react';
import {
  Button, CodeSnippet, ComposedModal, DataTable, InlineNotification, Link as CarbonLink, ModalBody, ModalFooter, ModalHeader, ProgressBar, Stack, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper,
  Tab, TabList, TabPanel, TabPanels, Table, TableBody, TableCell, TableContainer, TableExpandedRow, TableExpandHeader, TableExpandRow, TableHead, TableHeader, TableRow, Tabs, Tag,
} from '@carbon/react';
import { WarningAltFilled } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { connectorStatus, formatDateTime, formatRelative } from '../derived';
import { nozzleLabel } from '../printerSetup';
import { useStore } from '../store';
import { LinkifiedText, RichNotification } from './RefLink';
import type { ConnectorEventKind, ConnectorHost, ConnectorHostEvent, ConnectorRuntimeState, DetectedUnit, Machine, PrinterLiveStatus, PrinterProfile, PrinterRunState, Spool } from '../types';
import { DetectedTrayCell } from './DetectedTrayCell';

const STALE_AFTER_SECONDS = 300;

const eventLabels: Record<ConnectorEventKind, string> = {
  operational_state: 'State change', progress: 'Progress', filament_change: 'Filament change', consumption_report: 'Material consumption', terminal_outcome: 'Run outcome',
  hms_error: 'Printer warning', connectivity: 'Connection', config_applied: 'Configuration applied', heartbeat_restored: 'Heartbeat restored',
};
const quarantineReasons: Record<string, string> = {
  unknown_machine_serial: "Event for an unknown printer serial. Check the printer's serial number.",
};
const runtimeLabels: Record<ConnectorRuntimeState, string> = { connecting: 'Connecting', connected: 'Connected', disconnected: 'Disconnected', degraded: 'Degraded', disabled: 'Disabled' };
const runtimeTypes: Record<ConnectorRuntimeState, 'green' | 'purple' | 'gray' | 'red' | 'blue'> = { connecting: 'blue', connected: 'green', disconnected: 'red', degraded: 'purple', disabled: 'gray' };
const runStateMeta: Record<PrinterRunState, { label: string; type: 'green' | 'blue' | 'purple' | 'gray' | 'cyan' | 'red' }> = {
  idle: { label: 'Idle', type: 'gray' }, preparing: { label: 'Preparing', type: 'blue' }, printing: { label: 'Printing', type: 'green' },
  paused: { label: 'Paused', type: 'purple' }, finished: { label: 'Finished', type: 'cyan' }, failed: { label: 'Failed', type: 'red' },
};
const errorTexts: Record<string, string> = { MQTT_TIMEOUT: 'MQTT timeout' };

const ageSeconds = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
function relativeAge(iso: string) {
  const seconds = ageSeconds(iso);
  return seconds < 60 ? `${seconds} s ago` : formatRelative(iso);
}
function durationText(seconds: number) {
  return seconds < 60 ? `${seconds} s` : seconds < 3600 ? `${Math.round(seconds / 60)} min` : `${Math.round(seconds / 3600)} h`;
}
const remainingText = (minutes: number) => minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;

type PrinterView = { machine: Machine; live: PrinterLiveStatus | undefined; stale: boolean; issue: string | null };

function printerIssue(machine: Machine, live: PrinterLiveStatus | undefined, stale: boolean) {
  const code = machine.connection?.runtimeErrorCode;
  if (code) return errorTexts[code] ?? code;
  if (live?.printError) return `Print error ${live.printError}`;
  if (live && live.hms.length > 0) return `${live.hms.length} printer warning${live.hms.length === 1 ? '' : 's'}`;
  return stale ? 'No recent status' : null;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><div className="mj-metric__label">{label}</div><div className="mj-diag-value">{children}</div></div>;
}

function EventsTable({ events, caption }: { events: ConnectorHostEvent[]; caption: string }) {
  const sorted = [...events].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const rows = sorted.map((event) => ({ id: event.id, time: event.receivedAt, label: eventLabels[event.kind], summary: event.summary }));
  const headers = [{ key: 'time', header: 'Received' }, { key: 'label', header: 'Event' }, { key: 'summary', header: 'What happened' }];
  return (
    <DataTable rows={rows} headers={headers}>
      {({ rows: tableRows, headers: tableHeaders, getRowProps, getTableProps }) => (
        <TableContainer>
          <Table {...getTableProps()} size="sm" aria-label={caption}>
            <TableHead>
              <TableRow><TableExpandHeader aria-label="Raw payload" />{tableHeaders.map((header) => <TableHeader key={header.key}>{header.header}</TableHeader>)}</TableRow>
            </TableHead>
            <TableBody>
              {tableRows.map((row) => {
                const event = sorted.find((item) => item.id === row.id)!;
                const { key, ...rowProps } = getRowProps({ row });
                return (
                  <Fragment key={key}>
                    <TableExpandRow {...rowProps} aria-label={`Show raw payload of ${event.summary}`}>
                      <TableCell><span title={formatDateTime(event.receivedAt)}>{relativeAge(event.receivedAt)}</span></TableCell>
                      <TableCell>{eventLabels[event.kind]}</TableCell>
                      <TableCell><LinkifiedText text={event.summary} /></TableCell>
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
  );
}

function ConnectorPanel({ host, views, onSelect }: { host: ConnectorHost; views: PrinterView[]; onSelect: (machineId: string) => void }) {
  const status = connectorStatus(host);
  const quarantined = host.events.filter((event) => event.quarantine);
  const connectorEvents = host.events.filter((event) => event.machineId == null && !event.quarantine);
  const issue = views.find((view) => view.machine.connection?.runtimeErrorCode);
  const configured = host.configRevisionApplied === host.configRevisionDesired;
  const facts: [string, ReactNode][] = [
    ['Lifecycle', host.lifecycle.charAt(0).toUpperCase() + host.lifecycle.slice(1)],
    ['Health', <Tag key="h" size="sm" type={status.type}>{status.label}</Tag>],
    ['Software', host.softwareVersion ?? 'Unknown'],
    ['Configuration', `Revision ${host.configRevisionApplied} of ${host.configRevisionDesired} applied${configured ? '' : ' (update pending)'}`],
    ['Last heartbeat', host.lastHeartbeatAt ? relativeAge(host.lastHeartbeatAt) : 'Never'],
    ['Event queue', `${host.pendingEventCount} pending · ${host.quarantinedEventCount} quarantined`],
  ];
  return (
    <Stack gap={6}>
      {host.healthState === 'degraded' && host.lifecycle === 'active' && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title="Connector needs attention" subtitle={issue ? `${issue.machine.name}: ${issue.issue}. Printer status is unavailable over MQTT. Check LAN only mode, port 8883 and local network routing.` : 'One of its printers reports a problem.'} />
      )}
      <StructuredListWrapper isCondensed isFlush aria-label="Connector summary">
        <StructuredListBody>
          {facts.map(([label, value]) => (
            <StructuredListRow key={label}><StructuredListCell noWrap>{label}</StructuredListCell><StructuredListCell>{value}</StructuredListCell></StructuredListRow>
          ))}
        </StructuredListBody>
      </StructuredListWrapper>
      {quarantined.length > 0 && (
        <div>
          <h4 className="mj-group-title">Quarantined events</h4>
          <Stack gap={3}>
            {quarantined.map((event) => (
              <RichNotification key={event.id} kind="warning" title={quarantineReasons[event.quarantine!.reason] ?? `Event quarantined (${event.quarantine!.reason})`} ><LinkifiedText text={event.summary} /> · {relativeAge(event.receivedAt)}</RichNotification>
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
              {views.map(({ machine, live, issue: viewIssue }) => (
                <TableRow key={machine.id}>
                  <TableCell><CarbonLink href="#" onClick={(event) => { event.preventDefault(); onSelect(machine.id); }}>{machine.name}</CarbonLink></TableCell>
                  <TableCell>{machine.connection?.adapterKind === 'bambu_h2d' ? 'Bambu LAN' : 'Simulator'}</TableCell>
                  <TableCell>{machine.connection && <Tag size="sm" type={runtimeTypes[machine.connection.runtimeState]}>{runtimeLabels[machine.connection.runtimeState]}</Tag>}</TableCell>
                  <TableCell>{live ? relativeAge(live.receivedAt) : 'None yet'}</TableCell>
                  <TableCell>{viewIssue ?? <span className="mj-secondary">None</span>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div>
        <h4 className="mj-group-title">Connector events</h4>
        {connectorEvents.length === 0 ? <p className="mj-secondary">No connector-level events.</p> : <EventsTable events={connectorEvents} caption="Connector events" />}
      </div>
    </Stack>
  );
}

function MaterialSection({ live, units, profile, spools }: { live: PrinterLiveStatus; units: DetectedUnit[]; profile: PrinterProfile | undefined; spools: Spool[] }) {
  const active = live.activeTray;
  const mapping = (unitExt: string, trayExt: string) => {
    const inputUnit = profile?.inputUnits.find((unit) => unit.externalIdentifier === unitExt);
    const slot = inputUnit && profile?.slots.find((item) => item.inputUnitId === inputUnit.id && item.externalIdentifier === trayExt);
    if (!inputUnit || !slot) return null;
    return { inputUnit, slot, spool: spools.find((item) => item.id === slot.spoolId) };
  };
  // Compares what the printer reports with what Core believes is mounted.
  const mismatch = (tray: DetectedUnit['trays'][number], spool: Spool | undefined) => {
    if (tray.empty && spool) return 'Printer reports empty';
    if (!tray.empty && !spool && tray.rfid) return 'Not mounted in Core';
    if (spool && tray.materialType && !spool.materialName.toLowerCase().includes(tray.materialType.split(/[\s-]/)[0].toLowerCase())) return 'Material differs';
    return null;
  };
  return (
    <Stack gap={5}>
      {units.map((unit) => (
        <div key={unit.externalId}>
          <div className="mj-inline">
            <strong>{unit.label}</strong>
            <span className="mj-secondary">{nozzleLabel(unit.nozzle)}{unit.humidityPercent != null ? ` · ${unit.humidityPercent} % humidity` : ''}{unit.temperatureC != null ? ` · ${unit.temperatureC} °C` : ''}</span>
          </div>
          <Table size="sm" className="mj-diag-trays" aria-label={`${unit.label} trays`}>
            <TableHead>
              <TableRow><TableHeader>Printer slot</TableHeader><TableHeader>Reported</TableHeader><TableHeader>Core slot</TableHeader><TableHeader>Mounted spool</TableHeader><TableHeader>Status</TableHeader></TableRow>
            </TableHead>
            <TableBody>
              {unit.trays.map((tray, index) => {
                const feeding = active?.unitExternalId === unit.externalId && active.trayExternalId === tray.externalId;
                const mapped = mapping(unit.externalId, tray.externalId);
                const issue = mapped ? mismatch(tray, mapped.spool) : null;
                return (
                  <TableRow key={tray.externalId}>
                    <TableCell>{unit.kind === 'external' ? 'Spool' : `Slot ${index + 1}`}</TableCell>
                    <TableCell><DetectedTrayCell tray={tray} /></TableCell>
                    <TableCell>{mapped ? `${mapped.inputUnit.name} · ${mapped.slot.name}` : <span className="mj-secondary">Not mapped</span>}</TableCell>
                    <TableCell>{mapped?.spool ? <CarbonLink as={Link} to={`/inventory/spools/${mapped.spool.id}`}>{mapped.spool.displayId}</CarbonLink> : <span className="mj-secondary">—</span>}</TableCell>
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
      ))}
    </Stack>
  );
}

function PrinterPanel({ host, view }: { host: ConnectorHost; view: PrinterView }) {
  const store = useStore();
  const { machine, live, stale } = view;
  const detected = store.detected[machine.id];
  const profile = store.printerProfiles.find((item) => item.machineId === machine.id);
  const events = host.events.filter((event) => event.machineId === machine.id && !event.quarantine);
  const errorCode = machine.connection?.runtimeErrorCode;
  const profileSlots = profile?.slots.map((slot) => ({ slot, unit: profile.inputUnits.find((unit) => unit.id === slot.inputUnitId) })) ?? [];
  if (!live) {
    return (
      <Stack gap={5}>
        <InlineNotification kind="info" lowContrast hideCloseButton title="No status received yet" subtitle="This printer has not reported any data to the connector." />
        {events.length > 0 && <EventsTable events={events} caption={`${machine.name} events`} />}
      </Stack>
    );
  }
  const run = runStateMeta[live.state];
  return (
    <Stack gap={6}>
      <div className="mj-inline">
        <Tag size="sm" type={stale ? 'warm-gray' : 'green'}>{stale ? 'Status outdated' : 'Live'}</Tag>
        <span>Last status {relativeAge(live.receivedAt)}</span>
      </div>
      {stale && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title={`No status for ${durationText(ageSeconds(live.receivedAt))}${errorCode ? ` · ${errorTexts[errorCode] ?? errorCode}` : ''}`} subtitle="Check that the printer is on and LAN only mode is enabled. Values below are the last known ones." />
      )}
      <div>
        <h4 className="mj-group-title">Current job</h4>
        <Stack gap={3}>
          <div className="mj-inline"><Tag size="sm" type={run.type}>{run.label}</Tag>{live.job ? <strong>{live.job.fileName}</strong> : <span className="mj-secondary">{live.state === 'idle' ? 'Idle, no active job' : 'No active job'}</span>}</div>
          {live.job && (
            <ProgressBar
              value={live.job.progressPercent} max={100} size="small" status={live.state === 'failed' ? 'error' : 'active'}
              label={`${live.job.progressPercent} % · layer ${live.job.layer} of ${live.job.totalLayers} · about ${remainingText(live.job.remainingMinutes)} left`}
            />
          )}
        </Stack>
      </div>
      <div>
        <h4 className="mj-group-title">Temperatures</h4>
        <div className="mj-diag-grid">
          {[...live.temperatures.nozzles].sort((a, b) => a.side.localeCompare(b.side)).map((nozzle) => (
            <Fact key={nozzle.side} label={live.temperatures.nozzles.length > 1 ? nozzleLabel(nozzle.side) : 'Nozzle'}>{nozzle.targetC > 0 ? `${nozzle.currentC} / ${nozzle.targetC} °C` : `${nozzle.currentC} °C`}</Fact>
          ))}
          <Fact label="Bed">{live.temperatures.bedTargetC > 0 ? `${live.temperatures.bedC} / ${live.temperatures.bedTargetC} °C` : `${live.temperatures.bedC} °C`}</Fact>
          {live.temperatures.chamberC != null && <Fact label="Chamber">{live.temperatures.chamberC} °C</Fact>}
        </div>
      </div>
      {detected && detected.units.length > 0 ? (
        <div><h4 className="mj-group-title">Material</h4><MaterialSection live={live} units={detected.units} profile={profile} spools={store.spools} /></div>
      ) : profileSlots.length > 0 && (
        <div>
          <h4 className="mj-group-title">Material</h4>
          <Stack gap={2}>
            {profileSlots.map(({ slot, unit }) => {
              const spool = store.spools.find((item) => item.id === slot.spoolId);
              return <span key={slot.id}>{unit?.name} · {slot.name}: {spool ? `${spool.displayId} mounted` : <span className="mj-secondary">no spool mounted</span>}</span>;
            })}
          </Stack>
        </div>
      )}
      <div>
        <h4 className="mj-group-title">Health</h4>
        {live.hms.length === 0 && !live.printError ? <p className="mj-secondary">No errors reported.</p> : (
          <Stack gap={3}>
            {live.printError && <div className="mj-inline"><Tag size="sm" type="red">Print error</Tag><code>{live.printError}</code></div>}
            {live.hms.map((entry) => (
              <div key={`${entry.code}-${entry.at}`} className="mj-cell-stack">
                <span className="mj-inline"><Tag size="sm" type="purple">Warning</Tag><code>{entry.code}</code><span className="mj-secondary">{relativeAge(entry.at)}</span></span>
                <span className="mj-secondary">{entry.meaning ?? 'Meaning not documented'}</span>
              </div>
            ))}
          </Stack>
        )}
      </div>
      <div>
        <h4 className="mj-group-title">Device</h4>
        <div className="mj-diag-grid">
          <Fact label="Firmware">{live.firmware}</Fact>
          {[...live.nozzles].sort((a, b) => a.side.localeCompare(b.side)).map((nozzle) => <Fact key={nozzle.side} label={live.nozzles.length > 1 ? nozzleLabel(nozzle.side) : 'Nozzle'}>{nozzle.diameterMm} mm · {nozzle.type}</Fact>)}
          {live.wifiSignalDbm != null && <Fact label="Wi-Fi signal">{live.wifiSignalDbm} dBm</Fact>}
        </div>
      </div>
      <div>
        <h4 className="mj-group-title">Recent events</h4>
        {events.length === 0 ? <p className="mj-secondary">No events received for this printer.</p> : <EventsTable events={events} caption={`${machine.name} events`} />}
      </div>
    </Stack>
  );
}

export function DiagnosticsModal({ host, printers, onClose }: { host: ConnectorHost; printers: Machine[]; onClose: () => void }) {
  const store = useStore();
  const navigate = useNavigate();
  const [index, setIndex] = useState(0);
  const status = connectorStatus(host);
  const views: PrinterView[] = printers.map((machine) => {
    const live = store.liveStatus[machine.id];
    const stale = Boolean(live && (ageSeconds(live.receivedAt) > STALE_AFTER_SECONDS || machine.connection?.runtimeState === 'degraded'));
    return { machine, live, stale, issue: printerIssue(machine, live, stale) };
  });
  const selected = index > 0 ? views[index - 1] : undefined;
  return (
    <ComposedModal open size="lg" onClose={onClose} aria-label={`${host.name} diagnostics`}>
      <ModalHeader label="Connector diagnostics" title={<span className="mj-inline">{host.name}<Tag size="sm" type={status.type}>{status.label}</Tag></span>}>
        <p className="mj-secondary">{[host.locationLabel, host.softwareVersion ? `software ${host.softwareVersion}` : null, `last heartbeat ${host.lastHeartbeatAt ? relativeAge(host.lastHeartbeatAt) : 'never'}`].filter(Boolean).join(' · ')}</p>
      </ModalHeader>
      <ModalBody>
        <Tabs selectedIndex={index} onChange={({ selectedIndex }) => setIndex(selectedIndex)}>
          <TabList aria-label="Diagnostics sections" contained>
            <Tab>Connector</Tab>
            {views.map((view) => <Tab key={view.machine.id} renderIcon={view.issue ? WarningAltFilled : undefined}>{view.machine.name}</Tab>)}
          </TabList>
          <TabPanels>
            <TabPanel><ConnectorPanel host={host} views={views} onSelect={(machineId) => setIndex(views.findIndex((view) => view.machine.id === machineId) + 1)} /></TabPanel>
            {views.map((view) => <TabPanel key={view.machine.id}><PrinterPanel host={host} view={view} /></TabPanel>)}
          </TabPanels>
        </Tabs>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>Close</Button>
        {selected && <Button kind="primary" onClick={() => { onClose(); navigate(`/machines/${selected.machine.id}?tab=printer`); }}>Open printer setup</Button>}
      </ModalFooter>
    </ComposedModal>
  );
}
