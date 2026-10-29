import { useState } from 'react';
import {
  ActionableNotification,
  Button,
  ComboBox,
  DataTable,
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
  Tile,
  Toggle,
} from '@carbon/react';
import { Add, Link as LinkIcon, Unlink, WarningAlt } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { FilamentSpool, Machine, PrinterProfile, PrinterSlot } from '../../../api/generated/models';
import {
  configurePrinterProfile,
  mountPrinterSpool,
  unmountPrinterSpool,
} from '../../../api/generated/printing/printing';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { EmptyState } from '../../../app/PageState';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { liveStatusQuery, type PrinterConnection } from '../connectorQueries';
import { MachineSetupWizard } from '../dialogs/MachineSetupWizard';
import {
  adapterLabel,
  isBambuAdapter,
  mappingLabel,
  missingUnits,
  modelById,
  NOZZLE_GROUPS,
  nozzleLabel,
  profileUnitRefs,
  trayFor,
} from '../printerSetup';
import { machineLogbookKeys, spoolsQuery } from '../queries';
import { connectorDiagnostic } from '../shared/connectorHelpers';
import { formatRelative } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { colorsClearlyDiffer, reportedToMaterialHex } from '../colors';
import { DetectedTrayCell } from './DetectedTrayCell';
import type { StepKey } from './wizard/wizardTypes';
import { useFilamentChangeToasts } from './filamentChanges';
import { slotTag, slotHeaders, runtimeTag, spoolLabel } from './printerSetupShared';

const PRINTER_REFRESH_MS = 5000;

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
  const canReadConnectors = can('printer_connectors.read');
  const canManageConnectors = can('printer_connectors.manage');
  const [disableOpen, setDisableOpen] = useState(false);
  const [wizard, setWizard] = useState<{ step: StepKey; addDetected?: string } | null>(null);
  const [mountSlot, setMountSlot] = useState<PrinterSlot | null>(null);
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
  const unmount = useMutation({
    mutationFn: ({ slot }: { slot: PrinterSlot; unit: string }) => unmountPrinterSpool(slot.id),
    onSuccess: async (_saved, { slot, unit }) => {
      notify({ kind: 'success', title: 'Spool unmounted', subtitle: `${unit} · ${slot.name}` });
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

  const model = modelById(profile.model);
  const spoolById = (id: string | null | undefined) =>
    id ? mountedSpools.data?.items.find((spool) => spool.id === id) : undefined;
  const missing = missingUnits(detection, profileUnitRefs(profile));
  const units = profile.inputUnits.filter((unit) => unit.enabled).sort((a, b) => a.position - b.position);
  const multiNozzle = (model?.nozzles ?? 1) > 1 || units.some((unit) => unit.nozzle);
  const assignment = connection?.assignment;

  const renderUnit = (unitId: string) => {
    const unit = units.find((item) => item.id === unitId)!;
    const unitSlots = slots.filter((slot) => slot.inputUnitId === unit.id).sort((a, b) => a.position - b.position);
    return (
      <Tile key={unit.id}>
        <div className="mj-tile-header">
          <h4 className="mj-group-title">{unit.name}</h4>
        </div>
        {unitSlots.length === 0 ? (
          <p className="mj-secondary">No slots in this input unit.</p>
        ) : (
          <DataTable rows={unitSlots.map((slot) => ({ id: slot.id }))} headers={slotHeaders} size="sm">
            {({ rows, headers, getHeaderProps, getRowProps, getTableProps }) => (
              <TableContainer>
                <Table {...getTableProps()} aria-label={`Slots of ${unit.name}`}>
                  <TableHead>
                    <TableRow>
                      {headers.map((header) => {
                        const { key, ...headerProps } = getHeaderProps({ header });
                        return (
                          <TableHeader key={key} {...headerProps}>
                            {header.header}
                          </TableHeader>
                        );
                      })}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((tableRow) => {
                      // The Carbon row model may lag one render behind a
                      // polled profile whose slots changed.
                      const slot = unitSlots.find((item) => item.id === tableRow.id);
                      if (!slot) return null;
                      const spool = spoolById(slot.spoolId);
                      const tray = detection
                        ? trayFor(detection, unit.externalIdentifier ?? null, slot.externalIdentifier ?? null)
                        : null;
                      const colorMismatch = Boolean(
                        spool &&
                        tray &&
                        !tray.empty &&
                        colorsClearlyDiffer(
                          spool.colorHex,
                          tray.colorHex ? reportedToMaterialHex(tray.colorHex) : null,
                        ),
                      );
                      const mapping = mappingLabel(
                        detection,
                        profile.model,
                        unit.externalIdentifier ?? null,
                        slot.externalIdentifier ?? null,
                      );
                      const { key, ...rowProps } = getRowProps({ row: tableRow });
                      return (
                        <TableRow key={key} {...rowProps}>
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
                          <TableCell>{mapping ?? <span className="mj-secondary">Not mapped</span>}</TableCell>
                          <TableCell>
                            {detection ? (
                              <DetectedTrayCell
                                tray={trayFor(
                                  detection,
                                  unit.externalIdentifier ?? null,
                                  slot.externalIdentifier ?? null,
                                )}
                                unknownLabel={slot.externalIdentifier ? 'Not reported' : '—'}
                              />
                            ) : (
                              <span className="mj-secondary">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {slot.spoolId ? (
                              spool ? (
                                spoolLabel(spool)
                              ) : (
                                (slot.spoolDisplayId ?? 'Spool mounted')
                              )
                            ) : (
                              <span className="mj-secondary">Empty</span>
                            )}
                            {colorMismatch && (
                              <div className="mj-color-hint" role="note">
                                <WarningAlt size={16} aria-hidden /> The material colour (
                                {spool?.colorName ?? spool?.colorHex}) differs from the colour the printer reports for
                                this slot.
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {canAssign && slot.spoolId && (
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
                            {canAssign && canReadInventory && !slot.spoolId && slot.status === 'available' && (
                              <Button
                                kind="ghost"
                                size="sm"
                                renderIcon={LinkIcon}
                                onClick={() => {
                                  mount.reset();
                                  setMountSlot(slot);
                                }}
                              >
                                Mount spool
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </DataTable>
        )}
      </Tile>
    );
  };

  return (
    <Stack gap={6}>
      <Tile>
        <div className="mj-tile-header">
          <h3>Printing</h3>
          {canManage && (
            <Toggle
              id="profile-enabled"
              labelText="Printer profile enabled"
              hideLabel
              aria-label="Printer profile enabled"
              labelA="Disabled"
              labelB="Enabled"
              toggled={profile.enabled}
              disabled={configure.isPending}
              onToggle={(checked) => {
                if (checked) configure.mutate({ enabled: true });
                else {
                  configure.reset();
                  setDisableOpen(true);
                }
              }}
            />
          )}
          {!canManage && (
            <Tag type={profile.enabled ? 'green' : 'gray'}>{profile.enabled ? 'Enabled' : 'Disabled'}</Tag>
          )}
        </div>
        <p className="mj-secondary">
          Disabling the profile blocks new prints for this printer. Existing prints and history are kept.
        </p>
        {configure.isError && !disableOpen && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Printer profile not updated"
            subtitle="The profile may have changed. Reload and try again."
          />
        )}
      </Tile>

      {canReadConnectors && (
        <Tile>
          <div className="mj-tile-header">
            <h3>Connection</h3>
            {canManage && canManageConnectors && connection && (
              <Button kind="tertiary" size="sm" onClick={() => setWizard({ step: 'connection' })}>
                Edit connection
              </Button>
            )}
          </div>
          {connection && assignment ? (
            <dl className="mj-facts">
              <div>
                <dt>Connector</dt>
                <dd>
                  <CarbonLink as={Link} to={machineLogbookPaths.connectors()}>
                    {connection.connector.name}
                  </CarbonLink>
                </dd>
              </div>
              <div>
                <dt>Adapter</dt>
                <dd>{adapterLabel(assignment.adapterKind)}</dd>
              </div>
              {isBambuAdapter(assignment.adapterKind) && (
                <div>
                  <dt>IP address</dt>
                  <dd>{typeof assignment.settings.ipAddress === 'string' ? assignment.settings.ipAddress : '—'}</dd>
                </div>
              )}
              {isBambuAdapter(assignment.adapterKind) && (
                <div>
                  <dt>Serial number</dt>
                  <dd>
                    {typeof assignment.settings.serialNumber === 'string' ? assignment.settings.serialNumber : '—'}
                  </dd>
                </div>
              )}
              {isBambuAdapter(assignment.adapterKind) && (
                <div>
                  <dt>LAN access code</dt>
                  <dd>Set</dd>
                </div>
              )}
              {isBambuAdapter(assignment.adapterKind) && (
                <div>
                  <dt>Auto-mount RFID spools</dt>
                  <dd>{assignment.settings.autoDetectSpools === true ? 'On' : 'Off'}</dd>
                </div>
              )}
              <div>
                <dt>State</dt>
                <dd>
                  {assignment.runtimeState ? (
                    <Tag size="sm" type={runtimeTag[assignment.runtimeState]}>
                      {assignment.runtimeState}
                    </Tag>
                  ) : (
                    <span className="mj-secondary">Not reported</span>
                  )}
                  {assignment.runtimeErrorCode && (
                    <span className="mj-secondary"> {connectorDiagnostic(assignment.runtimeErrorCode)}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Last heartbeat</dt>
                <dd>
                  {connection.connector.lastHeartbeatAt ? formatRelative(connection.connector.lastHeartbeatAt) : '—'}
                </dd>
              </div>
            </dl>
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
        </Tile>
      )}

      <div className="mj-tile-header">
        <h3>Spool inputs</h3>
        {canManage && (
          <Button kind="tertiary" size="sm" onClick={() => setWizard({ step: 'spools' })}>
            Edit spool inputs
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
      {multiNozzle
        ? NOZZLE_GROUPS.map((group) => {
            const inGroup = units.filter((unit) => (unit.nozzle ?? null) === group);
            if (inGroup.length === 0) return null;
            return (
              <Stack key={group ?? 'none'} gap={4}>
                <h4 className="mj-group-title">{nozzleLabel(group)}</h4>
                {inGroup.map((unit) => renderUnit(unit.id))}
              </Stack>
            );
          })
        : units.map((unit) => renderUnit(unit.id))}

      <DestructiveActionDialog
        open={disableOpen}
        title="Disable printing?"
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
                placeholder="Search by ID or material"
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
    </Stack>
  );
}
