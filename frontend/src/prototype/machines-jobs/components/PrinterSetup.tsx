import { useState } from 'react';
import {
  Button, ComboBox, DataTable, InlineNotification, Modal, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, TextInput, Tile, Toggle,
} from '@carbon/react';
import { Add, Link as LinkIcon, Unlink } from '@carbon/icons-react';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { EmptyState } from '../../../app/PageState';
import { isConsumable } from './inventoryShared';
import { useSimulatedMutation, useStore } from '../store';
import type { InputUnit, Machine, PrinterProfile, Slot, SlotStatus, Spool } from '../types';

const slotTag: Record<SlotStatus, { label: string; type: 'green' | 'warm-gray' | 'gray' }> = {
  available: { label: 'Available', type: 'green' },
  unavailable: { label: 'Unavailable', type: 'warm-gray' },
  retired: { label: 'Retired', type: 'gray' },
};

const slotHeaders = [
  { key: 'slot', header: 'Slot' },
  { key: 'status', header: 'Status' },
  { key: 'spool', header: 'Mounted spool' },
  { key: 'actions', header: 'Actions' },
];

const spoolLabel = (spool: Spool) => `${spool.displayId}${spool.label ? ` (${spool.label})` : ''} · ${spool.materialName} · ${spool.remainingQuantity} g left`;

function NameModal({ open, title, label, helperText, submitLabel, onSubmit, onClose }: {
  open: boolean; title: string; label: string; helperText?: string; submitLabel: string; onSubmit: (name: string) => Promise<void>; onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const trimmed = name.trim();
  const close = () => { if (!pending) { setName(''); onClose(); } };
  const submit = async () => {
    if (!trimmed || pending) return;
    setPending(true);
    await onSubmit(trimmed);
    setPending(false);
    setName('');
    onClose();
  };
  return (
    <Modal
      open={open} size="xs" modalHeading={title} primaryButtonText={pending ? 'Saving…' : submitLabel} secondaryButtonText="Cancel"
      primaryButtonDisabled={!trimmed || pending} preventCloseOnClickOutside onRequestClose={close} onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <TextInput id={`name-modal-${title}`} labelText={label} helperText={helperText} value={name} autoComplete="off" data-modal-primary-focus onChange={(event) => setName(event.target.value)} />
      </form>
    </Modal>
  );
}

export function PrinterSetup({ machine, profile }: { machine: Machine; profile: PrinterProfile | undefined }) {
  const store = useStore();
  const canManage = store.can('machines.manage');
  const canAssign = store.can('printer_slots.assign');
  const canReadInventory = store.can('inventory.read');
  const [disableOpen, setDisableOpen] = useState(false);
  const [unitModal, setUnitModal] = useState(false);
  const [slotUnit, setSlotUnit] = useState<InputUnit | null>(null);
  const [mountSlot, setMountSlot] = useState<Slot | null>(null);
  const [selectedSpool, setSelectedSpool] = useState<Spool | null>(null);

  const createProfile = useSimulatedMutation(store.createProfile);
  const setEnabled = useSimulatedMutation(store.setProfileEnabled);
  const addUnit = useSimulatedMutation(store.addInputUnit);
  const addSlot = useSimulatedMutation(store.addSlot);
  const mount = useSimulatedMutation(store.mountSpool);
  const unmount = useSimulatedMutation(store.unmountSpool);

  if (!profile) {
    return (
      <EmptyState
        title="No printer profile" description="A printer profile lets this machine receive prints and track the spools loaded in its slots."
        action={canManage ? (
          <Button renderIcon={Add} disabled={createProfile.pending} onClick={async () => { await createProfile.mutate(machine.id); store.notify({ kind: 'success', title: 'Printer profile created', subtitle: machine.name }); }}>Create profile</Button>
        ) : undefined}
      />
    );
  }

  const freeSpools = store.spools.filter((spool) => !spool.mounted && isConsumable(spool));
  const spoolById = (id: string | null) => store.spools.find((spool) => spool.id === id);
  const closeMount = () => { setMountSlot(null); setSelectedSpool(null); };

  const toggleEnabled = async (enabled: boolean) => {
    await setEnabled.mutate(machine.id, enabled);
    store.notify({ kind: 'success', title: enabled ? 'Printing enabled' : 'Printing disabled', subtitle: machine.name });
    setDisableOpen(false);
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

      <div className="mj-tile-header">
        <h3>Input units</h3>
        {canManage && <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => setUnitModal(true)}>Add input unit</Button>}
      </div>
      {profile.inputUnits.length === 0 && <EmptyState title="No input units" description="Input units are the spool holders or material systems on this printer." />}
      {[...profile.inputUnits].sort((a, b) => a.position - b.position).map((unit) => {
        const slots = profile.slots.filter((slot) => slot.inputUnitId === unit.id).sort((a, b) => a.position - b.position);
        return (
          <Tile key={unit.id}>
            <div className="mj-tile-header">
              <h3>{unit.name}</h3>
              {canManage && <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setSlotUnit(unit)}>Add slot</Button>}
            </div>
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
                          const { key, ...rowProps } = getRowProps({ row: tableRow });
                          return (
                            <TableRow key={key} {...rowProps}>
                              <TableCell>{slot.name}</TableCell>
                              <TableCell><Tag type={slotTag[slot.status].type} size="sm">{slotTag[slot.status].label}</Tag></TableCell>
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
      })}

      <DestructiveActionDialog
        open={disableOpen} title="Disable printing?" confirmLabel="Disable profile" pending={setEnabled.pending}
        onClose={() => setDisableOpen(false)} onConfirm={() => { void toggleEnabled(false); }}
      >
        <p>{machine.name} will no longer accept new prints. Existing prints and history are kept, and you can enable the profile again at any time.</p>
      </DestructiveActionDialog>

      <NameModal
        open={unitModal} title="Add input unit" label="Name" helperText="For example Spool holder or AMS." submitLabel="Add input unit" onClose={() => setUnitModal(false)}
        onSubmit={async (name) => { await addUnit.mutate(machine.id, name); store.notify({ kind: 'success', title: 'Input unit added', subtitle: name }); }}
      />
      <NameModal
        open={Boolean(slotUnit)} title="Add slot" label="Slot name" helperText={slotUnit ? `Added to ${slotUnit.name}.` : undefined} submitLabel="Add slot" onClose={() => setSlotUnit(null)}
        onSubmit={async (name) => { if (slotUnit) await addSlot.mutate(machine.id, slotUnit.id, name); store.notify({ kind: 'success', title: 'Slot added', subtitle: name }); }}
      />

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
    </Stack>
  );
}
