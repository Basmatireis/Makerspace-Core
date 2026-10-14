import { useState } from 'react';
import {
  ActionableNotification, Button, ComboBox, DataTable, InlineNotification, Link as CarbonLink, Modal, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, Tile, Toggle,
} from '@carbon/react';
import { Add, Link as LinkIcon, Unlink } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { EmptyState } from '../../../app/PageState';
import { DetectedTrayCell } from './DetectedTrayCell';
import { isConsumable } from './inventoryShared';
import { MachineSetupWizard } from '../dialogs/MachineSetupWizard';
import { formatRelative } from '../derived';
import { mappingLabel, missingUnits, NOZZLE_GROUPS, nozzleLabel, profileUnitRefs, trayFor } from '../printerSetup';
import { modelById } from '../mockData';
import { useSimulatedMutation, useStore } from '../store';
import type { DetectedPrinterState, Machine, PrinterProfile, Slot, SlotStatus, Spool } from '../types';
import type { StepKey } from './wizard/wizardTypes';

const slotTag: Record<SlotStatus, { label: string; type: 'green' | 'warm-gray' | 'gray' }> = {
  available: { label: 'Available', type: 'green' },
  unavailable: { label: 'Unavailable', type: 'warm-gray' },
  retired: { label: 'Retired', type: 'gray' },
};

const slotHeaders = [
  { key: 'slot', header: 'Slot' },
  { key: 'mapping', header: 'Printer slot' },
  { key: 'detected', header: 'Detected' },
  { key: 'spool', header: 'Mounted spool' },
  { key: 'actions', header: 'Actions' },
];

const runtimeTag = { connected: 'green', connecting: 'blue', degraded: 'purple', disconnected: 'red', disabled: 'gray' } as const;

const spoolLabel = (spool: Spool) => `${spool.displayId}${spool.label ? ` (${spool.label})` : ''} · ${spool.materialName} · ${spool.remainingQuantity} g left`;

export function PrinterSetup({ machine, profile, detected }: { machine: Machine; profile: PrinterProfile | undefined; detected: DetectedPrinterState | null }) {
  const store = useStore();
  const canManage = store.can('machines.manage');
  const canAssign = store.can('printer_slots.assign');
  const canReadInventory = store.can('inventory.read');
  const [disableOpen, setDisableOpen] = useState(false);
  const [wizard, setWizard] = useState<{ step: StepKey; addDetected?: string } | null>(null);
  const [mountSlot, setMountSlot] = useState<Slot | null>(null);
  const [selectedSpool, setSelectedSpool] = useState<Spool | null>(null);

  const setEnabled = useSimulatedMutation(store.setProfileEnabled);
  const mount = useSimulatedMutation(store.mountSpool);
  const unmount = useSimulatedMutation(store.unmountSpool);
  const model = modelById(machine.modelId);
  const connection = machine.connection;
  const host = store.connectorHosts.find((item) => item.id === connection?.connectorId);

  const wizardDialog = <MachineSetupWizard open={Boolean(wizard)} onClose={() => setWizard(null)} machine={machine} initialStep={wizard?.step} addDetected={wizard?.addDetected} />;

  if (!profile) {
    return (
      <>
        <EmptyState
          title="No spool inputs" description="Set up the spool inputs of this printer so it can receive prints and track the spools loaded in its slots."
          action={canManage ? <Button renderIcon={Add} onClick={() => setWizard({ step: 'spools' })}>Create profile</Button> : undefined}
        />
        {wizardDialog}
      </>
    );
  }

  const freeSpools = store.spools.filter((spool) => !spool.mounted && isConsumable(spool));
  const spoolById = (id: string | null) => store.spools.find((spool) => spool.id === id);
  const closeMount = () => { setMountSlot(null); setSelectedSpool(null); };
  const missing = missingUnits(detected, profileUnitRefs(profile));
  const multiNozzle = (model?.nozzles ?? 1) > 1 || profile.inputUnits.some((unit) => unit.nozzle);
  const units = [...profile.inputUnits].sort((a, b) => a.position - b.position);

  const toggleEnabled = async (enabled: boolean) => {
    await setEnabled.mutate(machine.id, enabled);
    store.notify({ kind: 'success', title: enabled ? 'Printing enabled' : 'Printing disabled', subtitle: machine.name });
    setDisableOpen(false);
  };

  const renderUnit = (unitId: string) => {
    const unit = profile.inputUnits.find((item) => item.id === unitId)!;
    const slots = profile.slots.filter((slot) => slot.inputUnitId === unit.id).sort((a, b) => a.position - b.position);
    return (
      <Tile key={unit.id}>
        <div className="mj-tile-header"><h4 className="mj-group-title">{unit.name}</h4></div>
        {slots.length === 0 ? <p className="mj-secondary">No slots in this input unit.</p> : (
          <DataTable rows={slots.map((slot) => ({ id: slot.id }))} headers={slotHeaders} size="sm">
            {({ rows, headers, getHeaderProps, getRowProps, getTableProps }) => (
              <TableContainer>
                <Table {...getTableProps()} aria-label={`Slots of ${unit.name}`}>
                  <TableHead>
                    <TableRow>
                      {headers.map((header) => {
                        const { key, ...headerProps } = getHeaderProps({ header });
                        return <TableHeader key={key} {...headerProps}>{header.header}</TableHeader>;
                      })}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((tableRow) => {
                      const slot = slots.find((item) => item.id === tableRow.id)!;
                      const spool = spoolById(slot.spoolId);
                      const mapping = mappingLabel(detected, machine.modelId, unit.externalIdentifier, slot.externalIdentifier);
                      const { key, ...rowProps } = getRowProps({ row: tableRow });
                      return (
                        <TableRow key={key} {...rowProps}>
                          <TableCell><span className="mj-inline">{slot.name}{slot.status !== 'available' && <Tag type={slotTag[slot.status].type} size="sm">{slotTag[slot.status].label}</Tag>}</span></TableCell>
                          <TableCell>{mapping ?? <span className="mj-secondary">Not mapped</span>}</TableCell>
                          <TableCell>{detected ? <DetectedTrayCell tray={trayFor(detected, unit.externalIdentifier, slot.externalIdentifier)} unknownLabel={slot.externalIdentifier ? 'Not reported' : '—'} /> : <span className="mj-secondary">—</span>}</TableCell>
                          <TableCell>{slot.spoolId ? (canReadInventory && spool ? spoolLabel(spool) : 'Spool mounted') : <span className="mj-secondary">Empty</span>}</TableCell>
                          <TableCell>
                            {canAssign && slot.spoolId && (
                              <Button kind="ghost" size="sm" renderIcon={Unlink} disabled={unmount.pending} onClick={async () => { await unmount.mutate(machine.id, slot.id); store.notify({ kind: 'success', title: 'Spool unmounted', subtitle: `${unit.name} · ${slot.name}` }); }}>Unmount</Button>
                            )}
                            {canAssign && canReadInventory && !slot.spoolId && slot.status === 'available' && (
                              <Button kind="ghost" size="sm" renderIcon={LinkIcon} onClick={() => setMountSlot(slot)}>Mount spool</Button>
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
              id="profile-enabled" labelText="Printer profile enabled" hideLabel aria-label="Printer profile enabled" labelA="Disabled" labelB="Enabled" toggled={profile.enabled}
              disabled={setEnabled.pending}
              onToggle={(checked) => { if (checked) void toggleEnabled(true); else setDisableOpen(true); }}
            />
          )}
          {!canManage && <Tag type={profile.enabled ? 'green' : 'gray'}>{profile.enabled ? 'Enabled' : 'Disabled'}</Tag>}
        </div>
        <p className="mj-secondary">Disabling the profile blocks new prints for this printer. Existing prints and history are kept.</p>
      </Tile>

      <Tile>
        <div className="mj-tile-header">
          <h3>Connection</h3>
          {canManage && connection && <Button kind="tertiary" size="sm" onClick={() => setWizard({ step: 'connection' })}>Edit connection</Button>}
        </div>
        {connection ? (
          <dl className="mj-facts">
            <div><dt>Connector</dt><dd><CarbonLink as={Link} to="/machines?tab=connectors">{host?.name ?? 'Unknown connector'}</CarbonLink></dd></div>
            <div><dt>Adapter</dt><dd>{connection.adapterKind === 'bambu_h2d' ? 'Bambu Lab H2D' : 'Simulator'}</dd></div>
            {connection.adapterKind === 'bambu_h2d' && <div><dt>IP address</dt><dd>{connection.ipAddress ?? '—'}</dd></div>}
            {connection.adapterKind === 'bambu_h2d' && <div><dt>Serial number</dt><dd>{connection.serialNumber ?? '—'}</dd></div>}
            {connection.adapterKind === 'bambu_h2d' && <div><dt>LAN access code</dt><dd>{connection.accessCodeSet ? 'Set' : 'Not set'}</dd></div>}
            {connection.adapterKind === 'bambu_h2d' && <div><dt>Auto-mount RFID spools</dt><dd>{connection.autoMountRfid ? 'On' : 'Off'}</dd></div>}
            <div><dt>State</dt><dd><Tag size="sm" type={runtimeTag[connection.runtimeState]}>{connection.runtimeState}</Tag>{connection.runtimeErrorCode && <span className="mj-secondary"> {connection.runtimeErrorCode}</span>}</dd></div>
            <div><dt>Last heartbeat</dt><dd>{connection.lastHeartbeatAt ? formatRelative(connection.lastHeartbeatAt) : '—'}</dd></div>
          </dl>
        ) : (
          <EmptyState
            title="No connector" description="Connect this printer to collect prints automatically and see what is loaded in each slot."
            action={canManage ? <Button renderIcon={Add} onClick={() => setWizard({ step: 'connection' })}>Connect printer</Button> : undefined}
          />
        )}
      </Tile>

      <div className="mj-tile-header">
        <h3>Spool inputs</h3>
        {canManage && <Button kind="tertiary" size="sm" onClick={() => setWizard({ step: 'spools' })}>Edit spool inputs</Button>}
      </div>
      {canManage && missing.map((unit) => (
        <ActionableNotification
          key={unit.externalId} kind="info" lowContrast hideCloseButton inline title={`The printer reports ${unit.label} (${unit.externalId}), which isn't set up`}
          actionButtonLabel="Add as input unit" onActionButtonClick={() => setWizard({ step: 'spools', addDetected: unit.externalId })}
        />
      ))}
      {units.length === 0 && <EmptyState title="No input units" description="Input units are the spool holders or material systems on this printer." />}
      {multiNozzle
        ? NOZZLE_GROUPS.map((group) => {
          const inGroup = units.filter((unit) => (unit.nozzle ?? null) === group);
          if (inGroup.length === 0) return null;
          return <Stack key={group ?? 'none'} gap={4}><h4 className="mj-group-title">{nozzleLabel(group)}</h4>{inGroup.map((unit) => renderUnit(unit.id))}</Stack>;
        })
        : units.map((unit) => renderUnit(unit.id))}

      <DestructiveActionDialog
        open={disableOpen} title="Disable printing?" confirmLabel="Disable profile" pending={setEnabled.pending}
        onClose={() => setDisableOpen(false)} onConfirm={() => { void toggleEnabled(false); }}
      >
        <p>{machine.name} will no longer accept new prints. Existing prints and history are kept, and you can enable the profile again at any time.</p>
      </DestructiveActionDialog>

      <Modal
        open={Boolean(mountSlot)} size="sm" modalHeading="Mount spool" primaryButtonText={mount.pending ? 'Mounting…' : 'Mount spool'} secondaryButtonText="Cancel"
        primaryButtonDisabled={!selectedSpool || mount.pending} preventCloseOnClickOutside onRequestClose={closeMount}
        onRequestSubmit={async () => {
          if (!mountSlot || !selectedSpool) return;
          await mount.mutate(machine.id, mountSlot.id, selectedSpool.id);
          store.notify({ kind: 'success', title: 'Spool mounted', subtitle: `${selectedSpool.displayId} in ${mountSlot.name}` });
          closeMount();
        }}
      >
        {freeSpools.length === 0 ? (
          <InlineNotification kind="info" lowContrast hideCloseButton title="No spools available" subtitle="Every active spool is already mounted on a printer." />
        ) : (
          <ComboBox<Spool>
            autoAlign
            id="mount-spool" titleText="Spool" placeholder="Search by ID or material" helperText="Only spools that are not mounted are listed."
            items={freeSpools} itemToString={(spool) => (spool ? spoolLabel(spool) : '')} selectedItem={selectedSpool}
            onChange={({ selectedItem }) => setSelectedSpool(selectedItem ?? null)}
          />
        )}
      </Modal>
      {wizardDialog}
    </Stack>
  );
}
