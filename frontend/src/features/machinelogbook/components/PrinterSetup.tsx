import { useState } from 'react';
import {
  ActionableNotification,
  Button,
  ComboBox,
  InlineLoading,
  InlineNotification,
  Link as CarbonLink,
  Modal,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Toggle,
} from '@carbon/react';
import { Add, Edit, Link as LinkIcon, Unlink, WarningAlt } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type {
  FilamentSpool,
  Machine,
  PrinterInputUnit,
  PrinterLiveStatusTray,
  PrinterProfile,
  PrinterSlot,
} from '../../../api/generated/models';
import { updateMachine } from '../../../api/generated/machines/machines';
import { updatePrinterConnectorAssignment } from '../../../api/generated/printer-connectors/printer-connectors';
import {
  configurePrinterProfile,
  mountPrinterSpool,
  unmountPrinterSpool,
} from '../../../api/generated/printing/printing';
import { StackCard } from '../../../app/components/CardList';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { EmptyState } from '../../../app/PageState';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { colorsClearlyDiffer, reportedToMaterialHex } from '../colors';
import { connectorKeys, liveStatusQuery, type PrinterConnection } from '../connectorQueries';
import { MachineSetupWizard } from '../dialogs/MachineSetupWizard';
import { RegisterSlotSpoolModal } from '../dialogs/RegisterSlotSpoolModal';
import { codeSeverity, safeLink, severityLabel } from '../printerErrors/printerErrorText';
import {
  adapterLabel,
  isBambuAdapter,
  missingUnits,
  nozzleIndexLabel,
  profileUnitRefs,
  trayFor,
} from '../printerSetup';
import { machineLogbookKeys, printerErrorsQuery, spoolsQuery } from '../queries';
import { connectorDiagnostic } from '../shared/connectorHelpers';
import { formatDateTime, formatQuantity, formatRelative } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { MountCustomerFilamentModal } from '../dialogs/MountCustomerFilamentModal';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { DetectedTrayCell } from './DetectedTrayCell';
import { useFilamentChangeToasts } from './filamentChanges';
import { runtimeTag, slotTag, spoolLabel } from './printerSetupShared';
import { SummaryList } from './SummaryList';
import type { StepKey } from './wizard/wizardTypes';

const PRINTER_REFRESH_MS = 5000;
const EVENTS_SHOWN = 8;

/** A loaded spool the printer reports in a slot without a spool in Core. */
const unregistered = (tray: PrinterLiveStatusTray | null, slot: PrinterSlot) =>
  Boolean(tray && !tray.empty && (tray.rfid || tray.tagUid || tray.trayUuid) && !slot.assignmentId);

function PrinterEvents({ machineId }: { machineId: string }) {
  const can = useCan();
  const canRead = can('machines.read');
  const history = useQuery({ ...printerErrorsQuery(machineId), enabled: canRead });
  if (!canRead) return null;
  const items = (history.data?.items ?? []).slice(0, EVENTS_SHOWN);
  return (
    <StackCard title="Printer events" count={history.isSuccess ? items.length : undefined}>
      {history.isPending ? (
        <InlineLoading description="Loading printer events" />
      ) : history.isError ? (
        <p className="mj-secondary">The printer events could not be loaded.</p>
      ) : items.length === 0 ? (
        <p className="mj-secondary">No errors in the last 30 days.</p>
      ) : (
        <TableContainer className="mj-table-container mj-scroll-x">
          <Table size="md" aria-label="Printer events">
            <TableHead>
              <TableRow>
                <TableHeader>When</TableHeader>
                <TableHeader>Event</TableHeader>
                <TableHeader className="mj-hide-narrow">Run</TableHeader>
                <TableHeader>What to do</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item) => {
                const severity = item.severity ?? codeSeverity(item.sourceFamily, item.code);
                const link = safeLink(item.link);
                return (
                  <TableRow key={item.id}>
                    <TableCell>
                      <div className="mj-cell-stack">
                        <span>{formatRelative(item.firstObservedAt)}</span>
                        <span className="mj-secondary">
                          {item.resolvedAt ? `Resolved ${formatRelative(item.resolvedAt)}` : 'Still reported'}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="mj-col-wide">
                      <div className="mj-cell-stack">
                        <span className="mj-inline">
                          <code className="mj-code">{item.code}</code>
                          {item.sourceFamily === 'print' ? (
                            <Tag size="sm" type="red">
                              Print error
                            </Tag>
                          ) : severity ? (
                            <Tag size="sm" type={severity === 'fatal' || severity === 'serious' ? 'red' : 'outline'}>
                              {severityLabel[severity]}
                            </Tag>
                          ) : null}
                        </span>
                        <span className="mj-secondary">{item.title ?? 'No meaning recorded'}</span>
                      </div>
                    </TableCell>
                    <TableCell className="mj-hide-narrow">
                      {item.runId ? (
                        <CarbonLink as={Link} to={machineLogbookPaths.run(item.runId)}>
                          Open run
                        </CarbonLink>
                      ) : (
                        <span className="mj-secondary">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {item.description || link ? (
                        <div className="mj-cell-stack">
                          {item.description && <span>{item.description}</span>}
                          {link && (
                            <CarbonLink href={link} target="_blank" rel="noopener noreferrer" size="sm">
                              Read more
                            </CarbonLink>
                          )}
                        </div>
                      ) : (
                        <span className="mj-secondary">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </StackCard>
  );
}

export function PrinterSetup({
  machine,
  profile,
  connection,
  active = true,
}: {
  machine: Machine;
  profile: PrinterProfile | undefined;
  connection: PrinterConnection | undefined;
  active?: boolean;
}) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const canManage = can('machines.manage');
  const canAssign = can('printer_slots.assign');
  const canReadInventory = can('inventory.read');
  const canRegister = can('inventory.articles.manage') && canReadInventory;
  const canReadConnectors = can('printer_connectors.read');
  const canManageConnectors = can('printer_connectors.manage');
  const [disableOpen, setDisableOpen] = useState(false);
  const [wizard, setWizard] = useState<{ step: StepKey; addDetected?: string } | null>(null);
  const [mountSlot, setMountSlot] = useState<PrinterSlot | null>(null);
  const [customerSlot, setCustomerSlot] = useState<{ slot: PrinterSlot; unit: string } | null>(null);
  const [registering, setRegistering] = useState<{ slot: PrinterSlot; tray: PrinterLiveStatusTray } | null>(null);
  const [selectedSpool, setSelectedSpool] = useState<FilamentSpool | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const live = useQuery({
    ...liveStatusQuery(machine.id),
    enabled: active,
    refetchInterval: active ? PRINTER_REFRESH_MS : false,
  });
  const detection = live.data?.status ?? null;
  useFilamentChangeToasts(machine.id, detection, profile, notify);
  const slots = (profile?.slots ?? []).filter((slot) => slot.status !== 'retired');
  const hasMounted = slots.some((slot) => slot.spoolId);
  const mountedSpools = useQuery({
    ...spoolsQuery({ mounted: true, pageSize: 100 }),
    enabled: active && canReadInventory && hasMounted,
    refetchInterval: active ? PRINTER_REFRESH_MS : false,
  });
  const freeSpools = useQuery({
    ...spoolsQuery({ consumable: true, mounted: false, pageSize: 100 }),
    enabled: Boolean(mountSlot) && canAssign && canReadInventory,
  });

  const configure = useMutation({
    mutationFn: ({ enabled }: { enabled: boolean }) =>
      configurePrinterProfile(machine.id, { enabled, expectedVersion: profile?.version ?? 0 }),
    onSuccess: async (_saved, { enabled }) => {
      notify({ kind: 'success', title: enabled ? 'Printing enabled' : 'Printing disabled', subtitle: machine.name });
      setDisableOpen(false);
      await refresh();
    },
  });
  const collection = useMutation({
    mutationFn: (automatic: boolean) =>
      updateMachine(machine.id, {
        name: machine.name,
        processId: machine.process.id,
        status: machine.status,
        // The database only allows an external identifier together with automatic collection.
        externalIdentifier: automatic ? (machine.externalIdentifier ?? null) : null,
        automaticCollectionEnabled: automatic,
        expectedVersion: machine.version,
      }),
    onSuccess: async (_saved, automatic) => {
      notify({
        kind: 'success',
        title: automatic ? 'Runs are recorded automatically' : 'Runs are entered by hand',
        subtitle: machine.name,
      });
      await refresh();
    },
  });
  const assignmentSetting = useMutation({
    mutationFn: (change: { autoDetectSpools?: boolean; cameraStreaming?: boolean }) => {
      const assignment = connection!.assignment;
      return updatePrinterConnectorAssignment(connection!.connector.id, assignment.id, {
        adapterKind: assignment.adapterKind,
        adapterSchemaVersion: assignment.adapterSchemaVersion,
        settings:
          change.autoDetectSpools === undefined
            ? assignment.settings
            : { ...assignment.settings, autoDetectSpools: change.autoDetectSpools },
        enabled: assignment.enabled,
        ...(change.cameraStreaming === undefined ? {} : { cameraStreaming: change.cameraStreaming }),
        end: false,
        expectedVersion: assignment.version,
      });
    },
    onSuccess: async () => {
      notify({ kind: 'success', title: 'Recording setting saved', subtitle: machine.name });
      await Promise.all([refresh(), client.invalidateQueries({ queryKey: connectorKeys.all })]);
    },
  });
  const unmount = useMutation({
    mutationFn: ({ slot }: { slot: PrinterSlot; unit: string }) => unmountPrinterSpool(slot.id),
    onSuccess: async (_saved, { slot, unit }) => {
      notify({
        kind: 'success',
        title: slot.mountKind === 'customer' ? 'Customer filament unmounted' : 'Spool unmounted',
        subtitle: `${unit} · ${slot.name}`,
      });
      await refresh();
    },
    onError: () =>
      notify({
        kind: 'error',
        title: 'Spool not unmounted',
        subtitle: 'The slot may have changed. Reload and try again.',
      }),
  });
  const mount = useMutation({
    mutationFn: ({ slot, spool }: { slot: PrinterSlot; spool: FilamentSpool }) =>
      mountPrinterSpool(slot.id, { spoolId: spool.id }),
    onSuccess: async (_saved, { slot, spool }) => {
      notify({ kind: 'success', title: 'Spool mounted', subtitle: `${spool.displayId} in ${slot.name}` });
      setMountSlot(null);
      setSelectedSpool(null);
      await refresh();
    },
  });
  function closeMount() {
    setMountSlot(null);
    setSelectedSpool(null);
    mount.reset();
  }
  const closeIfIdle = useLatestCallback(() => {
    if (!mount.isPending) closeMount();
  });

  const wizardDialog = wizard && (
    <MachineSetupWizard
      open
      machine={machine}
      profile={profile}
      connection={connection}
      initialStep={wizard.step}
      detection={detection}
      addDetected={wizard.addDetected}
      onClose={() => setWizard(null)}
    />
  );

  if (!profile) {
    return (
      <>
        <EmptyState
          title="No printer profile"
          description="A printer profile lets this machine receive prints and track the spools loaded in its slots."
          action={
            canManage ? (
              <Button renderIcon={Add} onClick={() => setWizard({ step: 'machine' })}>
                Create profile
              </Button>
            ) : undefined
          }
        />
        {wizardDialog}
      </>
    );
  }

  const spoolById = (id: string | null | undefined) =>
    id ? mountedSpools.data?.items.find((spool) => spool.id === id) : undefined;
  const missing = missingUnits(detection, profileUnitRefs(profile));
  const units = profile.inputUnits.filter((unit) => unit.enabled).sort((a, b) => a.position - b.position);
  const assignment = connection?.assignment;
  const bambu = isBambuAdapter(assignment?.adapterKind);
  const setting = (key: string) =>
    typeof assignment?.settings[key] === 'string' ? (assignment.settings[key] as string) : null;
  const unitSlots = (unit: PrinterInputUnit) =>
    slots.filter((slot) => slot.inputUnitId === unit.id).sort((a, b) => a.position - b.position);
  const trayOf = (unit: PrinterInputUnit, slot: PrinterSlot) =>
    detection ? trayFor(detection, unit.externalIdentifier ?? null, slot.externalIdentifier ?? null) : null;
  const waiting = units.flatMap((unit) =>
    unitSlots(unit)
      .filter((slot) => unregistered(trayOf(unit, slot), slot))
      .map((slot) => ({ unit, slot, tray: trayOf(unit, slot)! })),
  );
  const connectorIssue =
    assignment?.runtimeState === 'degraded' || assignment?.runtimeState === 'disconnected'
      ? `Connector ${assignment.runtimeState}${assignment.runtimeErrorCode ? ` · ${assignment.runtimeErrorCode}` : ''}`
      : null;
  const mountedCount = slots.filter((slot) => slot.assignmentId).length;
  const canEditAssignment = canManage && canManageConnectors && Boolean(connection);
  const recordingDisabled = !profile.enabled;

  const renderSlot = (unit: PrinterInputUnit, slot: PrinterSlot) => {
    const spool = spoolById(slot.spoolId);
    const tray = trayOf(unit, slot);
    const waitingHere = unregistered(tray, slot);
    const colorMismatch = Boolean(
      spool &&
      tray &&
      !tray.empty &&
      colorsClearlyDiffer(spool.colorHex, tray.colorHex ? reportedToMaterialHex(tray.colorHex) : null),
    );
    return (
      <TableRow key={slot.id}>
        <TableCell>
          <span className="mj-inline">
            {slot.name}
            {slot.status !== 'available' && (
              <Tag type={slotTag[slot.status].type} size="sm">
                {slotTag[slot.status].label}
              </Tag>
            )}
          </span>
        </TableCell>
        <TableCell>
          {detection ? (
            <DetectedTrayCell tray={tray} unknownLabel={slot.externalIdentifier ? 'Not reported' : 'Not mapped'} />
          ) : (
            <span className="mj-secondary">—</span>
          )}
        </TableCell>
        <TableCell className="mj-col-wide">
          {slot.spoolId ? (
            <div className="mj-cell-stack">
              <span>
                <CarbonLink as={Link} to={machineLogbookPaths.spool(slot.spoolId)}>
                  {spool?.displayId ?? slot.spoolDisplayId ?? 'Spool'}
                </CarbonLink>
                {spool ? ` · ${spool.materialName}` : ''}
              </span>
              {spool && (
                <span className="mj-secondary">
                  {formatQuantity(spool.remainingQuantity)} g of {formatQuantity(spool.initialNetWeightG)} g left
                </span>
              )}
              {colorMismatch && (
                <span className="mj-color-hint" role="note">
                  <WarningAlt size={16} aria-hidden /> The article colour ({spool?.colorName ?? spool?.colorHex})
                  differs from the colour the printer reports.
                </span>
              )}
            </div>
          ) : slot.mountKind === 'customer' ? (
            <div className="mj-cell-stack">
              <span>
                <Tag type="teal" size="sm">
                  Customer filament
                </Tag>
              </span>
              <span className="mj-secondary">
                {[slot.customerMaterialTypeName, slot.customerColorName].filter(Boolean).join(' · ') ||
                  'Not charged and not booked from stock'}
              </span>
            </div>
          ) : waitingHere ? (
            <div className="mj-cell-stack">
              <span>
                <Tag type="purple" size="sm">
                  Not registered
                </Tag>
              </span>
              <span className="mj-secondary">Register it to track what this slot consumes.</span>
            </div>
          ) : (
            <span className="mj-secondary">Empty</span>
          )}
        </TableCell>
        <TableCell className="mj-col-num">
          {canAssign && slot.assignmentId && (
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Unlink}
              disabled={unmount.isPending}
              onClick={() => unmount.mutate({ slot, unit: unit.name })}
            >
              Unmount
            </Button>
          )}
          {!slot.assignmentId && waitingHere && canRegister && (
            <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setRegistering({ slot, tray: tray! })}>
              Register
            </Button>
          )}
          {canAssign && canReadInventory && !slot.assignmentId && !waitingHere && slot.status === 'available' && (
            <Button
              kind="ghost"
              size="sm"
              renderIcon={LinkIcon}
              onClick={() => {
                mount.reset();
                setMountSlot(slot);
              }}
            >
              Mount
            </Button>
          )}
          {canAssign && !slot.assignmentId && slot.status === 'available' && (
            <Button
              kind="ghost"
              size="sm"
              renderIcon={LinkIcon}
              onClick={() => setCustomerSlot({ slot, unit: unit.name })}
            >
              Mount customer filament
            </Button>
          )}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div className="mj-stack mj-stack--loose">
      {(waiting.length > 0 || connectorIssue) && (
        <ActionableNotification
          kind="warning"
          lowContrast
          hideCloseButton
          inline
          role="status"
          title="Needs attention"
          subtitle={[
            waiting.length
              ? `${waiting.length} ${waiting.length === 1 ? 'spool is' : 'spools are'} in the printer but not registered (${waiting
                  .map(({ unit, slot }) => `${unit.name} · ${slot.name}`)
                  .join(', ')})`
              : null,
            connectorIssue,
          ]
            .filter(Boolean)
            .join(' · ')}
          actionButtonLabel={
            waiting.length && canRegister
              ? waiting.length === 1
                ? 'Register the spool'
                : 'Register the first spool'
              : connectorIssue && canEditAssignment
                ? 'Test connection'
                : ''
          }
          onActionButtonClick={() => {
            if (waiting.length && canRegister) setRegistering({ slot: waiting[0].slot, tray: waiting[0].tray });
            else setWizard({ step: 'connection' });
          }}
        />
      )}
      <div className="mj-two-col">
        {canReadConnectors && (
          <StackCard
            title="Connection"
            action={
              canEditAssignment ? (
                <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setWizard({ step: 'connection' })}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            {connection && assignment ? (
              <>
                <SummaryList
                  label="Connection"
                  items={[
                    {
                      label: 'State',
                      value: assignment.runtimeState ? (
                        <span className="mj-inline">
                          <Tag size="sm" type={runtimeTag[assignment.runtimeState]}>
                            {assignment.runtimeState}
                          </Tag>
                          {assignment.runtimeErrorCode && (
                            <span className="mj-secondary">{connectorDiagnostic(assignment.runtimeErrorCode)}</span>
                          )}
                        </span>
                      ) : (
                        <span className="mj-secondary">Not reported</span>
                      ),
                    },
                    {
                      label: 'Connector',
                      value: (
                        <CarbonLink as={Link} to={machineLogbookPaths.connectors()}>
                          {connection.connector.name}
                        </CarbonLink>
                      ),
                    },
                    { label: 'Adapter', value: adapterLabel(assignment.adapterKind) },
                    bambu && setting('serialNumber')
                      ? { label: 'Serial number', value: setting('serialNumber'), mono: true }
                      : null,
                    bambu && setting('ipAddress')
                      ? { label: 'IP address', value: setting('ipAddress'), mono: true }
                      : null,
                    bambu ? { label: 'LAN access code', value: 'Set, never shown' } : null,
                    detection?.firmwareVersion ? { label: 'Firmware', value: detection.firmwareVersion } : null,
                    {
                      label: 'Last heartbeat',
                      value: connection.connector.lastHeartbeatAt
                        ? formatRelative(connection.connector.lastHeartbeatAt)
                        : '—',
                    },
                    live.data ? { label: 'Last report', value: formatDateTime(live.data.receivedAt) } : null,
                  ]}
                />
                {canEditAssignment && (
                  <div>
                    <Button kind="tertiary" size="md" onClick={() => setWizard({ step: 'connection' })}>
                      Test connection
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <EmptyState
                title="No connector"
                description="Connect this printer to collect prints automatically and see what is loaded in each slot."
                action={
                  canManage && canManageConnectors ? (
                    <Button renderIcon={Add} onClick={() => setWizard({ step: 'connection' })}>
                      Connect printer
                    </Button>
                  ) : undefined
                }
              />
            )}
          </StackCard>
        )}
        <StackCard title="Recording">
          <div className="mj-toggles">
            <Toggle
              id="profile-enabled"
              labelText="Printer profile enabled"
              labelA="Off"
              labelB="On"
              toggled={profile.enabled}
              disabled={!canManage || configure.isPending}
              onToggle={(checked) => {
                if (checked) configure.mutate({ enabled: true });
                else {
                  configure.reset();
                  setDisableOpen(true);
                }
              }}
            />
            <p className="mj-secondary">Core talks to this printer and accepts its prints.</p>
            <Toggle
              id="record-automatically"
              labelText="Record runs automatically"
              labelA="Off"
              labelB="On"
              toggled={machine.automaticCollectionEnabled}
              disabled={!canManage || collection.isPending || recordingDisabled}
              onToggle={(checked) => collection.mutate(checked)}
            />
            <p className="mj-secondary">
              Every print becomes a run; prints nobody claims wait on the Jobs page. Turning it off also clears the
              external identifier.
            </p>
            {connection && (
              <>
                <Toggle
                  id="auto-mount-rfid"
                  labelText="Auto-mount RFID spools"
                  labelA="Off"
                  labelB="On"
                  toggled={assignment?.settings.autoDetectSpools === true}
                  disabled={!bambu || !canEditAssignment || assignmentSetting.isPending || recordingDisabled}
                  onToggle={(checked) => assignmentSetting.mutate({ autoDetectSpools: checked })}
                />
                <p className="mj-secondary">
                  {bambu
                    ? 'A registered spool is mounted as soon as the AMS reads its tag.'
                    : 'Not supported by this adapter.'}
                </p>
                <Toggle
                  id="camera-streaming"
                  labelText="Relay the camera to signage"
                  labelA="Off"
                  labelB="On"
                  toggled={assignment?.cameraStreaming === true}
                  disabled={!bambu || !canEditAssignment || assignmentSetting.isPending || recordingDisabled}
                  onToggle={(checked) => assignmentSetting.mutate({ cameraStreaming: checked })}
                />
                <p className="mj-secondary">
                  {bambu ? 'Displays can show the live camera of this printer.' : 'Not supported by this adapter.'}
                </p>
              </>
            )}
            <p className="mj-secondary">
              Print files, previews and timelapses are kept as set in{' '}
              <CarbonLink as={Link} to="/settings/local-services?tab=recording" size="sm">
                Local services › Recording
              </CarbonLink>
              .
            </p>
            {(configure.isError || collection.isError || assignmentSetting.isError) && !disableOpen && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Setting not saved"
                subtitle="The printer may have changed. Reload and try again."
              />
            )}
          </div>
        </StackCard>
      </div>

      <section className="mj-slot-units" aria-labelledby="spool-slots-title">
        <div className="mj-slot-units__head">
          <h2 id="spool-slots-title" className="mj-slot-units__title">
            Spool slots{' '}
            <span className="mj-secondary">
              {mountedCount} / {slots.length} mounted
            </span>
          </h2>
          {canManage && (
            <Button kind="primary" size="md" renderIcon={Edit} onClick={() => setWizard({ step: 'spools' })}>
              Edit slots
            </Button>
          )}
        </div>
        {live.isPending && <InlineLoading description="Checking what the printer reports" />}
        {canManage &&
          missing.map((unit) => (
            <ActionableNotification
              key={unit.externalId}
              kind="info"
              lowContrast
              hideCloseButton
              inline
              role="status"
              title={`The printer reports ${unit.label} (${unit.externalId}), which isn't set up`}
              actionButtonLabel="Add as input unit"
              onActionButtonClick={() => setWizard({ step: 'spools', addDetected: unit.externalId })}
            />
          ))}
        {units.length === 0 && (
          <EmptyState
            title="No input units"
            description="Input units are the spool holders or material systems on this printer."
          />
        )}
        {units.map((unit) => {
          const inUnit = unitSlots(unit);
          return (
            <div key={unit.id} className="mj-slot-unit">
              <h3 className="mj-slot-unit__title">
                {unit.name}
                {profile.nozzleCount > 1 && (
                  <span className="mj-secondary">
                    {' '}
                    · feeds {nozzleIndexLabel(unit.nozzleIndex, profile.nozzleCount).toLowerCase()}
                  </span>
                )}
              </h3>
              {inUnit.length === 0 ? (
                <p className="mj-slot-units__note">No slots in this input unit.</p>
              ) : (
                <TableContainer className="mj-table-container mj-scroll-x">
                  <Table size="md" aria-label={`Slots of ${unit.name}`}>
                    <TableHead>
                      <TableRow>
                        <TableHeader>Slot</TableHeader>
                        <TableHeader>Printer reports</TableHeader>
                        <TableHeader>Spool in Core</TableHeader>
                        <TableHeader className="mj-col-num">
                          <span className="cds--visually-hidden">Actions</span>
                        </TableHeader>
                      </TableRow>
                    </TableHead>
                    <TableBody>{inUnit.map((slot) => renderSlot(unit, slot))}</TableBody>
                  </Table>
                </TableContainer>
              )}
            </div>
          );
        })}
        <p className="mj-slot-units__note">
          Registered spools with an RFID tag mount themselves; everything else is mounted here or from the spool list.
          Material is only booked on slots with a spool in Core.
        </p>
      </section>

      <PrinterEvents machineId={machine.id} />

      <DestructiveActionDialog
        open={disableOpen}
        title="Disable printing?"
        fate="none"
        confirmLabel="Disable profile"
        pending={configure.isPending}
        error={configure.isError ? 'The profile could not be disabled. Reload and try again.' : undefined}
        onClose={() => setDisableOpen(false)}
        onConfirm={() => configure.mutate({ enabled: false })}
      >
        <p>
          {machine.name} will no longer accept new prints. Existing prints and history are kept, and you can enable the
          profile again at any time.
        </p>
      </DestructiveActionDialog>

      {registering && (
        <RegisterSlotSpoolModal
          machineName={machine.name}
          slot={registering.slot}
          tray={registering.tray}
          canMount={canAssign && registering.slot.status === 'available'}
          onClose={() => setRegistering(null)}
        />
      )}

      {customerSlot && (
        <MountCustomerFilamentModal
          slot={customerSlot.slot}
          unitName={customerSlot.unit}
          onClose={() => setCustomerSlot(null)}
          onMounted={() => {
            notify({
              kind: 'success',
              title: 'Customer filament mounted',
              subtitle: `${customerSlot.unit} · ${customerSlot.slot.name}`,
            });
            setCustomerSlot(null);
            void refresh();
          }}
        />
      )}

      {mountSlot && (
        <Modal
          open
          size="sm"
          modalHeading="Mount spool"
          primaryButtonText={mount.isPending ? 'Mounting…' : 'Mount spool'}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={!selectedSpool || mount.isPending}
          preventCloseOnClickOutside
          onRequestClose={closeIfIdle}
          onRequestSubmit={() => {
            if (mountSlot && selectedSpool && !mount.isPending) mount.mutate({ slot: mountSlot, spool: selectedSpool });
          }}
        >
          <Stack gap={5}>
            {freeSpools.isPending && <InlineLoading description="Loading spools" />}
            {freeSpools.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Spools could not be loaded"
                subtitle="Close the dialog and try again."
              />
            )}
            {freeSpools.isSuccess && freeSpools.data.items.length === 0 && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="No spools available"
                subtitle="Every active spool is already mounted on a printer."
              />
            )}
            {freeSpools.isSuccess && freeSpools.data.items.length > 0 && (
              <ComboBox<FilamentSpool>
                autoAlign
                id="mount-spool"
                titleText="Spool"
                placeholder="Search by label or material"
                helperText="Only spools that are not mounted are listed."
                items={freeSpools.data.items}
                itemToString={(spool) => (spool ? spoolLabel(spool) : '')}
                selectedItem={selectedSpool}
                shouldFilterItem={({ item, inputValue }) =>
                  !inputValue || spoolLabel(item).toLowerCase().includes(inputValue.toLowerCase())
                }
                onChange={({ selectedItem }) => setSelectedSpool(selectedItem ?? null)}
              />
            )}
            {mount.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Spool not mounted"
                subtitle="The slot or spool may have changed. Choose again and retry."
              />
            )}
          </Stack>
        </Modal>
      )}
      {wizardDialog}
    </div>
  );
}
