import { useState } from 'react';
import {
  Button, ComboBox, DataTable, InlineLoading, InlineNotification, Modal, Select, SelectItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag, TextInput, Tile, Toggle,
} from '@carbon/react';
import { Add, Edit, Link as LinkIcon, Unlink } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import type { FilamentSpool, Machine, PrinterInputUnit, PrinterProfile, PrinterSlot, PrinterSlotStatus } from '../../../api/generated/models';
import { configurePrinterProfile, createPrinterInputUnit, createPrinterSlot, mountPrinterSpool, unmountPrinterSpool, updatePrinterInputUnit, updatePrinterSlot } from '../../../api/generated/printing/printing';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { EmptyState } from '../../../app/PageState';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { machineLogbookKeys, spoolsQuery } from '../queries';
import { formatQuantity } from '../shared/format';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';

const slotTag: Record<PrinterSlotStatus, { label: string; type: 'green' | 'warm-gray' | 'gray' }> = {
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

const spoolLabel = (spool: FilamentSpool) => `${spool.displayId}${spool.label ? ` (${spool.label})` : ''} · ${spool.materialName ?? 'No material'} · ${formatQuantity(spool.remainingQuantity)} ${spool.unit ?? 'g'} left`;
const nextPosition = (items: { position: number }[]) => items.reduce((max, item) => Math.max(max, item.position), -1) + 1;

type TopologyValues = { name: string; externalIdentifier: string; status: PrinterSlotStatus };

function TopologyModal({ title, label, helperText, submitLabel, initialName = '', initialExternalIdentifier = '', status, onSubmit, onClose }: {
  title: string; label: string; helperText?: string; submitLabel: string; initialName?: string; initialExternalIdentifier?: string; status?: PrinterSlotStatus;
  onSubmit: (values: { name: string; externalIdentifier: string | null; status?: PrinterSlotStatus }) => Promise<void>; onClose: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<TopologyValues>({
    defaultValues: { name: initialName, externalIdentifier: initialExternalIdentifier, status: status ?? 'available' },
  });
  const close = useLatestCallback(() => { if (!isSubmitting) { setFailed(false); onClose(); } });
  const submit = handleSubmit(async (values) => {
    setFailed(false);
    try {
      await onSubmit({
        name: values.name.trim(),
        externalIdentifier: values.externalIdentifier.trim() || null,
        status: status === undefined ? undefined : values.status,
      });
      onClose();
    } catch {
      setFailed(true);
    }
  });
  return (
    <Modal
      open size="xs" modalHeading={title} primaryButtonText={isSubmitting ? 'Saving…' : submitLabel} secondaryButtonText="Cancel"
      primaryButtonDisabled={isSubmitting} preventCloseOnClickOutside onRequestClose={close} onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <Stack gap={5}>
          <TextInput
            id={`topology-name-${title}`} labelText={label} helperText={helperText} autoComplete="off" data-modal-primary-focus
            invalid={Boolean(errors.name)} invalidText={errors.name?.message}
            {...register('name', { required: 'Enter a name.', maxLength: { value: 120, message: 'Use at most 120 characters.' }, validate: (value) => Boolean(value.trim()) || 'Enter a name.' })}
          />
          <TextInput
            id={`topology-external-${title}`} labelText="External identifier" helperText="Use the exact identifier reported by the printer. Leave blank for manually managed holders."
            invalid={Boolean(errors.externalIdentifier)} invalidText={errors.externalIdentifier?.message}
            {...register('externalIdentifier', { maxLength: { value: 200, message: 'Use at most 200 characters.' } })}
          />
          {status !== undefined && (
            <Select id={`topology-status-${title}`} labelText="Status" {...register('status')}>
              <SelectItem value="available" text="Available" />
              <SelectItem value="unavailable" text="Unavailable" />
              <SelectItem value="retired" text="Retired" />
            </Select>
          )}
          {failed && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle="Check the name and that the printer profile has not changed, then try again." />}
        </Stack>
      </form>
    </Modal>
  );
}

export function PrinterSetup({ machine, profile }: { machine: Machine; profile: PrinterProfile | undefined }) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const canManage = can('machines.manage');
  const canAssign = can('printer_slots.assign');
  const canReadInventory = can('inventory.read');
  const [disableOpen, setDisableOpen] = useState(false);
  const [unitEditor, setUnitEditor] = useState<PrinterInputUnit | 'new' | null>(null);
  const [slotEditor, setSlotEditor] = useState<{ unit: PrinterInputUnit; slot?: PrinterSlot } | null>(null);
  const [mountSlot, setMountSlot] = useState<PrinterSlot | null>(null);
  const [selectedSpool, setSelectedSpool] = useState<FilamentSpool | null>(null);

  const refresh = () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const hasMounted = Boolean(profile?.slots.some((slot) => slot.spoolId));
  const mountedSpools = useQuery({ ...spoolsQuery({ mounted: true, pageSize: 100 }), enabled: canReadInventory && hasMounted });
  const freeSpools = useQuery({ ...spoolsQuery({ consumable: true, mounted: false, pageSize: 100 }), enabled: Boolean(mountSlot) && canAssign && canReadInventory });

  const configure = useMutation({
    mutationFn: ({ enabled }: { enabled: boolean }) => configurePrinterProfile(machine.id, { enabled, expectedVersion: profile?.version ?? 0 }),
    onSuccess: async (_saved, { enabled }) => {
      notify({ kind: 'success', title: !profile ? 'Printer profile created' : enabled ? 'Printing enabled' : 'Printing disabled', subtitle: machine.name });
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
    onError: () => notify({ kind: 'error', title: 'Spool not unmounted', subtitle: 'The slot may have changed. Reload and try again.' }),
  });
  const mount = useMutation({
    mutationFn: ({ slot, spool }: { slot: PrinterSlot; spool: FilamentSpool }) => mountPrinterSpool(slot.id, { spoolId: spool.id }),
    onSuccess: async (_saved, { slot, spool }) => {
      notify({ kind: 'success', title: 'Spool mounted', subtitle: `${spool.displayId} in ${slot.name}` });
      closeMount();
      await refresh();
    },
  });

  const closeIfIdle = useLatestCallback(() => { if (!mount.isPending) closeMount(); });

  if (!profile) {
    return (
      <EmptyState
        title="No printer profile" description="A printer profile lets this machine receive prints and track the spools loaded in its slots."
        action={canManage ? (
          <Button renderIcon={Add} disabled={configure.isPending} onClick={() => configure.mutate({ enabled: true })}>Create profile</Button>
        ) : undefined}
      />
    );
  }

  const spoolById = (id: string | null | undefined) => (id ? mountedSpools.data?.items.find((spool) => spool.id === id) : undefined);
  function closeMount() { setMountSlot(null); setSelectedSpool(null); mount.reset(); }

  const saveUnit = async ({ name, externalIdentifier }: { name: string; externalIdentifier: string | null }) => {
    if (unitEditor === 'new') {
      await createPrinterInputUnit(machine.id, { name, position: nextPosition(profile.inputUnits), externalIdentifier });
      notify({ kind: 'success', title: 'Input unit added', subtitle: name });
    } else if (unitEditor) {
      await updatePrinterInputUnit(unitEditor.id, { name, position: unitEditor.position, externalIdentifier, enabled: unitEditor.enabled, expectedVersion: unitEditor.version });
      notify({ kind: 'success', title: 'Input unit updated', subtitle: name });
    }
    await refresh();
  };
  const saveSlot = async ({ name, externalIdentifier, status }: { name: string; externalIdentifier: string | null; status?: PrinterSlotStatus }) => {
    if (!slotEditor) return;
    if (slotEditor.slot) {
      const slot = slotEditor.slot;
      await updatePrinterSlot(slot.id, { name, position: slot.position, status: status ?? slot.status, externalIdentifier, expectedVersion: slot.version });
      notify({ kind: 'success', title: 'Slot updated', subtitle: name });
    } else {
      await createPrinterSlot(slotEditor.unit.id, { name, position: nextPosition(profile.slots.filter((slot) => slot.inputUnitId === slotEditor.unit.id)), status: status ?? 'available', externalIdentifier });
      notify({ kind: 'success', title: 'Slot added', subtitle: name });
    }
    await refresh();
  };

  return (
    <Stack gap={6}>
      <Tile>
        <div className="mj-tile-header">
          <h3>Printing</h3>
          {canManage && (
            <Toggle
              id="profile-enabled" labelText="Printer profile enabled" hideLabel aria-label="Printer profile enabled" labelA="Disabled" labelB="Enabled" toggled={profile.enabled}
              disabled={configure.isPending}
              onToggle={(checked) => { if (checked) configure.mutate({ enabled: true }); else { configure.reset(); setDisableOpen(true); } }}
            />
          )}
          {!canManage && <Tag type={profile.enabled ? 'green' : 'gray'}>{profile.enabled ? 'Enabled' : 'Disabled'}</Tag>}
        </div>
        <p className="mj-secondary">Disabling the profile blocks new prints for this printer. Existing prints and history are kept.</p>
        {configure.isError && !disableOpen && <InlineNotification kind="error" lowContrast hideCloseButton title="Printer profile not updated" subtitle="The profile may have changed. Reload and try again." />}
      </Tile>

      <div className="mj-tile-header">
        <h3>Input units</h3>
        {canManage && <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => setUnitEditor('new')}>Add input unit</Button>}
      </div>
      {profile.inputUnits.length === 0 && <EmptyState title="No input units" description="Input units are the spool holders or material systems on this printer." />}
      {[...profile.inputUnits].sort((a, b) => a.position - b.position).map((unit) => {
        const slots = profile.slots.filter((slot) => slot.inputUnitId === unit.id).sort((a, b) => a.position - b.position);
        return (
          <Tile key={unit.id}>
            <div className="mj-tile-header">
              <div><h3>{unit.name}</h3><p className="mj-secondary">External ID: {unit.externalIdentifier ?? 'Not set'}</p></div>
              {canManage && <Stack orientation="horizontal" gap={3}><Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setUnitEditor(unit)}>Edit input unit</Button><Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setSlotEditor({ unit })}>Add slot</Button></Stack>}
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
                              <TableCell><div className="mj-cell-stack"><span>{slot.name}</span><span className="mj-secondary">External ID: {slot.externalIdentifier ?? 'Not set'}</span></div></TableCell>
                              <TableCell><Tag type={slotTag[slot.status].type} size="sm">{slotTag[slot.status].label}</Tag></TableCell>
                              <TableCell>{slot.spoolId ? (spool ? spoolLabel(spool) : slot.spoolDisplayId ?? 'Spool mounted') : <span className="mj-secondary">Empty</span>}</TableCell>
                              <TableCell>
                                {canManage && <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setSlotEditor({ unit, slot })}>Edit slot</Button>}
                                {canAssign && slot.spoolId && (
                                  <Button kind="ghost" size="sm" renderIcon={Unlink} disabled={unmount.isPending} onClick={() => unmount.mutate({ slot, unit: unit.name })}>Unmount</Button>
                                )}
                                {canAssign && canReadInventory && !slot.spoolId && slot.status === 'available' && (
                                  <Button kind="ghost" size="sm" renderIcon={LinkIcon} onClick={() => { mount.reset(); setMountSlot(slot); }}>Mount spool</Button>
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
        open={disableOpen} title="Disable printing?" confirmLabel="Disable profile" pending={configure.isPending}
        error={configure.isError ? 'The profile could not be disabled. Reload and try again.' : undefined}
        onClose={() => setDisableOpen(false)} onConfirm={() => configure.mutate({ enabled: false })}
      >
        <p>{machine.name} will no longer accept new prints. Existing prints and history are kept, and you can enable the profile again at any time.</p>
      </DestructiveActionDialog>

      {unitEditor && (
        <TopologyModal
          title={unitEditor === 'new' ? 'Add input unit' : 'Edit input unit'} label="Name" helperText="For example Spool holder or AMS."
          submitLabel={unitEditor === 'new' ? 'Add input unit' : 'Save input unit'} initialName={unitEditor === 'new' ? '' : unitEditor.name}
          initialExternalIdentifier={unitEditor === 'new' ? '' : unitEditor.externalIdentifier ?? ''} onClose={() => setUnitEditor(null)}
          onSubmit={saveUnit}
        />
      )}
      {slotEditor && (
        <TopologyModal
          title={slotEditor.slot ? 'Edit slot' : 'Add slot'} label="Slot name" helperText={`${slotEditor.slot ? 'Belongs' : 'Added'} to ${slotEditor.unit.name}.`}
          submitLabel={slotEditor.slot ? 'Save slot' : 'Add slot'} initialName={slotEditor.slot?.name}
          initialExternalIdentifier={slotEditor.slot?.externalIdentifier ?? ''} status={slotEditor.slot?.status ?? 'available'} onClose={() => setSlotEditor(null)}
          onSubmit={saveSlot}
        />
      )}

      {mountSlot && <Modal
        open size="sm" modalHeading="Mount spool" primaryButtonText={mount.isPending ? 'Mounting…' : 'Mount spool'} secondaryButtonText="Cancel"
        primaryButtonDisabled={!selectedSpool || mount.isPending} preventCloseOnClickOutside onRequestClose={closeIfIdle}
        onRequestSubmit={() => { if (mountSlot && selectedSpool && !mount.isPending) mount.mutate({ slot: mountSlot, spool: selectedSpool }); }}
      >
        <Stack gap={5}>
          {freeSpools.isPending && <InlineLoading description="Loading spools" />}
          {freeSpools.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Spools could not be loaded" subtitle="Close the dialog and try again." />}
          {freeSpools.isSuccess && freeSpools.data.items.length === 0 && (
            <InlineNotification kind="info" lowContrast hideCloseButton title="No spools available" subtitle="Every active spool is already mounted on a printer." />
          )}
          {freeSpools.isSuccess && freeSpools.data.items.length > 0 && (
            <ComboBox<FilamentSpool>
              autoAlign
              id="mount-spool" titleText="Spool" placeholder="Search by ID or material" helperText="Only spools that are not mounted are listed."
              items={freeSpools.data.items} itemToString={(spool) => (spool ? spoolLabel(spool) : '')} selectedItem={selectedSpool}
              shouldFilterItem={({ item, inputValue }) => !inputValue || spoolLabel(item).toLowerCase().includes(inputValue.toLowerCase())}
              onChange={({ selectedItem }) => setSelectedSpool(selectedItem ?? null)}
            />
          )}
          {mount.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Spool not mounted" subtitle="The slot or spool may have changed. Choose again and retry." />}
        </Stack>
      </Modal>}
    </Stack>
  );
}
