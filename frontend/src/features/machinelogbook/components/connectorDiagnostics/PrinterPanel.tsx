import {
  InlineNotification,
  Link as CarbonLink,
  ProgressBar,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { WarningAltFilled } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type {
  PrinterConnectorEvent,
  PrinterLiveStatus,
  PrinterLiveStatusUnit,
  PrinterProfile,
} from '../../../../api/generated/models';
import { liveStatusQuery, observedRunsQuery } from '../../connectorQueries';
import { printerQuery, spoolsQuery } from '../../queries';
import { externalHolderNozzle, nozzleLabel, trayMismatch, type MountedSpool, type Nozzle } from '../../printerSetup';
import { ageSeconds } from '../../shared/connectorStatus';
import { connectorDiagnostic } from '../../shared/connectorHelpers';
import { machineLogbookPaths } from '../../shared/paths';
import { useCan } from '../../shared/useCan';
import { DetectedTrayCell } from '../DetectedTrayCell';
import {
  STALE_AFTER_SECONDS,
  LIVE_REFRESH_MS,
  runStateMeta,
  relativeAge,
  durationText,
  remainingText,
  temperature,
  PrinterView,
} from './diagnosticsShared';
import { Fact } from './Fact';
import { EventsTable } from './EventsTable';

function MaterialSection({
  units,
  active,
  profile,
  spools,
}: {
  units: PrinterLiveStatusUnit[];
  active: PrinterLiveStatus['status']['activeTray'];
  profile: PrinterProfile | undefined;
  spools: MountedSpool[];
}) {
  const mapping = (unitExt: string, trayExt: string) => {
    const inputUnit = profile?.inputUnits.find((unit) => unit.enabled && unit.externalIdentifier === unitExt);
    const slot =
      inputUnit &&
      profile?.slots.find(
        (item) => item.inputUnitId === inputUnit.id && item.status !== 'retired' && item.externalIdentifier === trayExt,
      );
    if (!inputUnit || !slot) return null;
    const mounted: MountedSpool | undefined = slot.spoolId
      ? (spools.find((item) => item.id === slot.spoolId) ?? {
          id: slot.spoolId,
          displayId: slot.spoolDisplayId ?? null,
          materialName: null,
        })
      : undefined;
    return { inputUnit, slot, spool: mounted };
  };
  const nozzleOf = (unit: PrinterLiveStatusUnit): Nozzle | null =>
    profile?.inputUnits.find((item) => item.externalIdentifier === unit.externalId)?.nozzle ??
    (unit.kind === 'external' ? externalHolderNozzle(unit.externalId) : null);
  return (
    <Stack gap={5}>
      {units.map((unit) => {
        const nozzle = nozzleOf(unit);
        return (
          <div key={unit.externalId}>
            <div className="mj-inline">
              <strong>{unit.label}</strong>
              <span className="mj-secondary">
                {[
                  nozzle ? nozzleLabel(nozzle) : null,
                  unit.humidityPercent != null ? `${unit.humidityPercent} % humidity` : null,
                  unit.temperatureC != null ? `${unit.temperatureC} °C` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            <Table size="sm" className="mj-diag-trays" aria-label={`${unit.label} trays`}>
              <TableHead>
                <TableRow>
                  <TableHeader>Printer slot</TableHeader>
                  <TableHeader>Reported</TableHeader>
                  <TableHeader>Core slot</TableHeader>
                  <TableHeader>Mounted spool</TableHeader>
                  <TableHeader>Status</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {unit.trays.map((tray, index) => {
                  const feeding =
                    active?.unitExternalId === unit.externalId && active.trayExternalId === tray.externalId;
                  const mapped = mapping(unit.externalId, tray.externalId);
                  const issue = mapped ? trayMismatch(tray, mapped.spool) : null;
                  return (
                    <TableRow key={tray.externalId}>
                      <TableCell>{unit.kind === 'external' ? 'Spool' : `Slot ${index + 1}`}</TableCell>
                      <TableCell>
                        <DetectedTrayCell tray={tray} />
                      </TableCell>
                      <TableCell>
                        {mapped ? (
                          `${mapped.inputUnit.name} · ${mapped.slot.name}`
                        ) : (
                          <span className="mj-secondary">Not mapped</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {mapped?.spool ? (
                          <CarbonLink as={Link} to={machineLogbookPaths.spool(mapped.spool.id)}>
                            {mapped.spool.displayId ?? 'Spool'}
                          </CarbonLink>
                        ) : (
                          <span className="mj-secondary">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className="mj-inline">
                          {feeding && (
                            <Tag size="sm" type="green">
                              Feeding now
                            </Tag>
                          )}
                          {issue && (
                            <Tag size="sm" type="warm-gray" renderIcon={WarningAltFilled}>
                              {issue}
                            </Tag>
                          )}
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

export function PrinterPanel({
  view,
  events,
  active,
}: {
  view: PrinterView;
  events: PrinterConnectorEvent[];
  active: boolean;
}) {
  const can = useCan();
  const { assignment } = view;
  const machineId = assignment.machineId;
  // Only the visible printer is polled; the others keep what the connector tab already loaded.
  const liveQuery = useQuery({
    ...liveStatusQuery(machineId),
    enabled: active,
    refetchInterval: active ? LIVE_REFRESH_MS : false,
  });
  const profileQuery = useQuery({
    ...printerQuery(machineId),
    enabled: active,
    retry: false,
    refetchInterval: active ? LIVE_REFRESH_MS : false,
  });
  const profile = profileQuery.data;
  const canReadInventory = can('inventory.read');
  const mountedSpools = useQuery({
    ...spoolsQuery({ mounted: true, pageSize: 100 }),
    enabled: active && canReadInventory && Boolean(profile?.slots.some((slot) => slot.spoolId)),
    refetchInterval: active ? LIVE_REFRESH_MS : false,
  });
  const runs = useQuery({
    ...observedRunsQuery(assignment.connectorId),
    enabled: active,
    refetchInterval: active ? LIVE_REFRESH_MS : false,
  });
  const spools: MountedSpool[] = (mountedSpools.data?.items ?? []).map((spool) => ({
    id: spool.id,
    displayId: spool.displayId,
    materialName: spool.materialName ?? null,
  }));
  const live = liveQuery.data === undefined ? view.live : liveQuery.data;
  const errorCode = assignment.runtimeErrorCode;
  // Assignment health also covers the independent artifact worker. An FTPS
  // retry must not make a fresh MQTT snapshot look stale.
  const stale = Boolean(live && ageSeconds(live.receivedAt) > STALE_AFTER_SECONDS);
  const printerRuns = (runs.data?.items ?? []).filter((run) => run.machineId === machineId).slice(0, 5);
  const eventsTable =
    events.length === 0 ? (
      <p className="mj-secondary">No events received for this printer.</p>
    ) : (
      <EventsTable events={events} caption={`${assignment.machineName} events`} />
    );

  if (!live) {
    return (
      <Stack gap={5}>
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="No status received yet"
          subtitle={
            errorCode ? connectorDiagnostic(errorCode) : 'This printer has not reported any data to the connector.'
          }
        />
        {events.length > 0 && eventsTable}
      </Stack>
    );
  }
  const snapshot = live.status;
  const run = runStateMeta[snapshot.state];
  const job = snapshot.job;
  const jobLabel = job
    ? [
        job.progressPercent != null ? `${job.progressPercent} %` : null,
        job.layer != null && job.totalLayers != null ? `layer ${job.layer} of ${job.totalLayers}` : null,
        job.remainingMinutes != null ? `about ${remainingText(job.remainingMinutes)} left` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const nozzleName = (side: Nozzle | null, id: number, total: number) =>
    total > 1 ? (side ? nozzleLabel(side) : `Extruder ${id}`) : 'Nozzle';
  return (
    <Stack gap={6}>
      <div className="mj-inline">
        <Tag size="sm" type={stale ? 'warm-gray' : 'green'}>
          {stale ? 'Status outdated' : 'Live'}
        </Tag>
        <span>Last status {relativeAge(live.receivedAt)}</span>
      </div>
      {stale && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title={`No status for ${durationText(ageSeconds(live.receivedAt))}${errorCode ? ` · ${errorCode}` : ''}`}
          subtitle={
            errorCode
              ? `${connectorDiagnostic(errorCode)} Values below are the last known ones.`
              : 'Check that the printer is on and LAN only mode is enabled. Values below are the last known ones.'
          }
        />
      )}
      {!stale && errorCode && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title={`${errorCode.toLowerCase().includes('ftps') || errorCode.toLowerCase().includes('artifact') ? 'Print file delayed' : 'Connector needs attention'} · ${errorCode}`}
          subtitle={connectorDiagnostic(errorCode)}
        />
      )}
      <div>
        <h4 className="mj-group-title">Current job</h4>
        <Stack gap={3}>
          <div className="mj-inline">
            <Tag size="sm" type={run.type}>
              {run.label}
            </Tag>
            {job?.fileName ? (
              <strong>{job.fileName}</strong>
            ) : (
              <span className="mj-secondary">
                {snapshot.state === 'idle' ? 'Idle, no active job' : 'No active job'}
              </span>
            )}
          </div>
          {job?.progressPercent != null && (
            <ProgressBar
              value={job.progressPercent}
              max={100}
              size="small"
              status={snapshot.state === 'failed' ? 'error' : 'active'}
              label={jobLabel}
            />
          )}
        </Stack>
      </div>
      <div>
        <h4 className="mj-group-title">Temperatures</h4>
        <div className="mj-diag-grid">
          {[...snapshot.temperatures.extruders]
            .sort((a, b) => a.extruderId - b.extruderId)
            .map((nozzle) => (
              <Fact
                key={nozzle.extruderId}
                label={nozzleName(nozzle.side, nozzle.extruderId, snapshot.temperatures.extruders.length)}
              >
                {temperature(nozzle.currentC, nozzle.targetC)}
              </Fact>
            ))}
          <Fact label="Bed">{temperature(snapshot.temperatures.bedC, snapshot.temperatures.bedTargetC)}</Fact>
          {snapshot.temperatures.chamberC != null && <Fact label="Chamber">{snapshot.temperatures.chamberC} °C</Fact>}
        </div>
      </div>
      {snapshot.units.length > 0 ? (
        <div>
          <h4 className="mj-group-title">Material</h4>
          <MaterialSection units={snapshot.units} active={snapshot.activeTray} profile={profile} spools={spools} />
        </div>
      ) : (
        (profile?.slots.filter((slot) => slot.status !== 'retired').length ?? 0) > 0 && (
          <div>
            <h4 className="mj-group-title">Material</h4>
            <Stack gap={2}>
              {profile!.slots
                .filter((slot) => slot.status !== 'retired')
                .map((slot) => (
                  <span key={slot.id}>
                    {slot.inputUnitName} · {slot.name}:{' '}
                    {slot.spoolId ? (
                      `${slot.spoolDisplayId ?? 'Spool'} mounted`
                    ) : (
                      <span className="mj-secondary">no spool mounted</span>
                    )}
                  </span>
                ))}
            </Stack>
          </div>
        )
      )}
      <div>
        <h4 className="mj-group-title">Health</h4>
        {snapshot.errors.length === 0 ? (
          <p className="mj-secondary">No errors reported.</p>
        ) : (
          <Stack gap={3}>
            {snapshot.errors.map((error) => (
              <span key={`${error.sourceFamily}-${error.code}`} className="mj-inline">
                <Tag size="sm" type={error.sourceFamily === 'print' ? 'red' : 'purple'}>
                  {error.sourceFamily === 'print' ? 'Print error' : 'Warning'}
                </Tag>
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
          {[...snapshot.nozzles]
            .sort((a, b) => a.extruderId - b.extruderId)
            .map((nozzle) => (
              <Fact key={nozzle.extruderId} label={nozzleName(nozzle.side, nozzle.extruderId, snapshot.nozzles.length)}>
                {[nozzle.diameterMm != null ? `${nozzle.diameterMm} mm` : null, nozzle.type]
                  .filter(Boolean)
                  .join(' · ') || 'Unknown'}
              </Fact>
            ))}
          {snapshot.wifiSignalDbm != null && <Fact label="Wi-Fi signal">{snapshot.wifiSignalDbm} dBm</Fact>}
        </div>
      </div>
      {printerRuns.length > 0 && (
        <div>
          <h4 className="mj-group-title">Observed print runs</h4>
          <Stack gap={2}>
            {printerRuns.map((item) => (
              <span key={item.id}>
                {item.vendorJobId ?? item.id} · {item.state}{' '}
                <span className="mj-secondary">
                  last seen {relativeAge(item.lastObservedAt)}
                  {item.historyComplete ? '' : ' · incomplete history'}
                </span>
              </span>
            ))}
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
