import { CatalogFormModal } from './CatalogFormModal';
import { useLatestCallback } from '../../app/useLatestCallback';
import './styles.scss';
import './catalog.scss';
import { Add, Connect } from '@carbon/icons-react';
import { Button, InlineNotification, Pagination, Search, Select, SelectItem, Stack, Tag, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useParams } from 'react-router-dom';
import { configurePrinterProfile, createPrinterInputUnit, createPrinterSlot, mountPrinterSpool, unmountPrinterSpool } from '../../api/generated/printing/printing';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { RowActions } from '../../app/RowActions';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { machineLogbookKeys, machineQuery, printerQuery, spoolsQuery } from './queries';
import { MachinePageShell } from './MachinePageShell';

type Dialog = 'unit' | 'slot' | 'mount' | null;
type Fields = { name: string; position: number; externalIdentifier: string; inputUnitId: string; status: 'available' | 'unavailable' | 'retired'; spoolId: string };
const defaults: Fields = { name: '', position: 0, externalIdentifier: '', inputUnitId: '', status: 'available', spoolId: '' };

export function PrinterProfilePage() {
  const { machineId = '' } = useParams();
  const currentUser = useCurrentUser();
  const canConfigure = hasPermission(currentUser, PermissionId.machinesmanage);
  const canAssign = hasPermission(currentUser, PermissionId.printer_slotsassign);
  const canReadInventory = hasPermission(currentUser, PermissionId.inventoryread);
  const canMount = canAssign && canReadInventory && hasPermission(currentUser, PermissionId.machinesread);
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedSlotId, setSelectedSlotId] = useState('');
  const [unmountTarget, setUnmountTarget] = useState<{ id: string; name: string } | null>(null);
  const [disableOpen, setDisableOpen] = useState(false);
  const [spoolSearch, setSpoolSearch] = useState('');
  const [spoolPage, setSpoolPage] = useState(1);
  const form = useForm<Fields>({ defaultValues: defaults, shouldUnregister: true });
  const guard = useUnsavedChanges({ isDirty: dialog !== null && form.formState.isDirty, onDiscard: () => { form.reset(defaults); setDialog(null); } });
  const profile = useQuery({ ...printerQuery(machineId), retry: false });
  const machine = useQuery(machineQuery(machineId));
  const spools = useQuery({ ...spoolsQuery({ lifecycle: 'active', search: spoolSearch || undefined, page: spoolPage, pageSize: 25 }), enabled: dialog === 'mount' && canMount });
  const refresh = async () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const configure = useMutation({ mutationFn: (enabled: boolean) => configurePrinterProfile(machineId, { enabled, expectedVersion: profile.data?.version ?? 0 }), onSuccess: async () => { setDisableOpen(false); await refresh(); } });
  const mutation = useMutation<unknown, Error, Fields>({
    mutationFn: (values) => {
      if (dialog === 'unit') return createPrinterInputUnit(machineId, { name: values.name, position: Number(values.position), externalIdentifier: values.externalIdentifier || null });
      if (dialog === 'slot') return createPrinterSlot(values.inputUnitId, { name: values.name, position: Number(values.position), status: values.status, externalIdentifier: values.externalIdentifier || null });
      return mountPrinterSpool(selectedSlotId, { spoolId: values.spoolId });
    },
    onSuccess: async () => { setDialog(null); form.reset(defaults); await refresh(); },
  });
  const unmount = useMutation({ mutationFn: (slotId: string) => unmountPrinterSpool(slotId), onSuccess: async () => { setUnmountTarget(null); await refresh(); } });
  const open = (kind: Exclude<Dialog, null>, inputUnitId = '', slotId = '') => { mutation.reset(); form.reset({ ...defaults, inputUnitId }); setSelectedSlotId(slotId); setSpoolPage(1); setSpoolSearch(''); setDialog(kind); };
  const close = useLatestCallback(() => { if (!mutation.isPending) guard.requestDiscard(() => { form.reset(defaults); setDialog(null); }); });
  const absent = profile.isError && profile.error instanceof ApiError && profile.error.status === 404;
  if (machine.isPending || profile.isPending) return <FullPageLoading label="Loading printer configuration" />;
  if (!machine.data) return <ErrorState message="This machine could not be loaded." onRetry={() => machine.refetch()} />;
  if (profile.isError && !absent && !profile.data) return <MachinePageShell machine={machine.data} printer><ErrorState message="Printer configuration could not be loaded." onRetry={() => profile.refetch()} /></MachinePageShell>;
  const item = profile.data;
  return <MachinePageShell machine={machine.data} printer actions={canConfigure && <>{item ? <><Button kind="secondary" disabled={configure.isPending} onClick={() => { configure.reset(); if (item.enabled) setDisableOpen(true); else if (!configure.isPending) configure.mutate(true); }}>{item.enabled ? 'Disable printer profile' : 'Enable printer profile'}</Button><Button renderIcon={Add} onClick={() => open('unit')}>Add input unit</Button></> : <Button disabled={configure.isPending} onClick={() => { if (!configure.isPending) configure.mutate(true); }}>Configure as printer</Button>}</>}>
    {configure.isError && !disableOpen && <InlineNotification kind="error" lowContrast hideCloseButton title="Printer profile not updated" subtitle="The profile may have changed. Reload its current version and retry." />}
    {!item ? <EmptyState title="No printer profile" description="Create a printer profile before adding input units and filament slots." /> : <>
      <Tag type={item.enabled ? 'green' : 'gray'}>{item.enabled ? 'Printer profile enabled' : 'Printer profile disabled'}</Tag>
      {!item.enabled && <p className="section-description">New print submissions require an enabled profile. Existing topology and history are retained.</p>}
      {canAssign && !canReadInventory && <InlineNotification kind="info" lowContrast hideCloseButton title="Mounting requires inventory access" subtitle="Inventory read permission is needed to select and mount a spool. Existing spools can still be unmounted." />}
      <div className="detail-grid">{item.inputUnits.map((unit) => <Tile key={unit.id}><div className="section-heading"><div><h2>{unit.name}</h2><p className="section-description">{unit.externalIdentifier || 'No external identifier'} · Position {unit.position}</p></div>{canConfigure && <Button kind="ghost" size="sm" onClick={() => open('slot', unit.id)}>Add slot</Button>}</div>
        <Stack gap={4}>{item.slots.filter((slot) => slot.inputUnitId === unit.id).map((slot) => <Tile key={slot.id}><div className="section-heading"><div><h3>{slot.name}</h3><p className="section-description">Position {slot.position}{slot.externalIdentifier ? ` · ${slot.externalIdentifier}` : ''}</p><Tag type={slot.status === 'available' ? 'green' : 'gray'}>{slot.status}</Tag>{slot.spoolDisplayId && <Tag type="blue">{slot.spoolDisplayId}</Tag>}</div><RowActions label={`Actions for ${slot.name}`}>{canAssign && slot.spoolId && <Button kind="danger--tertiary" size="sm" onClick={() => { unmount.reset(); setUnmountTarget({ id: slot.id, name: slot.name }); }}>Unmount</Button>}{canMount && !slot.spoolId && <Button kind="tertiary" size="sm" renderIcon={Connect} disabled={slot.status !== 'available'} title={slot.status !== 'available' ? 'Only available slots can receive a spool.' : undefined} onClick={() => open('mount', unit.id, slot.id)}>Mount spool</Button>}</RowActions></div></Tile>)}</Stack>
      </Tile>)}</div>
      {!item.inputUnits.length && <EmptyState title="No input units" description="Add a direct feed, multi-material unit, or another physical filament input." />}
    </>}
    {dialog !== null && <CatalogFormModal open={!guard.dialogOpen} selectorPrimaryFocus={dialog === 'mount' ? '#mount-spool' : '#topology-name'} modalHeading={dialog === 'unit' ? 'Add printer input unit' : dialog === 'slot' ? 'Add filament slot' : 'Mount filament spool'} primaryButtonText={mutation.isPending ? 'Saving…' : 'Save'} secondaryButtonText="Cancel" primaryButtonDisabled={mutation.isPending || (dialog === 'mount' && (!canMount || spools.isPending || spools.isError))} preventCloseOnClickOutside onRequestClose={close} onRequestSubmit={form.handleSubmit((values) => { if (!mutation.isPending && (dialog !== 'mount' || (canMount && spools.isSuccess))) mutation.mutate(values); })}><Stack gap={5}>
      {(dialog === 'unit' || dialog === 'slot') && <><TextInput id="topology-name" labelText="Name" invalid={!!form.formState.errors.name} invalidText="Enter a name." {...form.register('name', { required: true, validate: (value) => !!value.trim() })} /><TextInput id="topology-position" type="number" labelText="Position" min={0} invalid={!!form.formState.errors.position} invalidText="Enter a non-negative whole number." {...form.register('position', { valueAsNumber: true, required: true, min: 0, validate: Number.isInteger })} /><TextInput id="topology-external" labelText="External identifier" {...form.register('externalIdentifier')} /><input type="hidden" {...form.register('inputUnitId')} /></>}
      {dialog === 'slot' && <Select id="slot-status" labelText="Status" {...form.register('status')}><SelectItem value="available" text="Available" /><SelectItem value="unavailable" text="Unavailable" /><SelectItem value="retired" text="Retired" /></Select>}
      {dialog === 'mount' && <><Search labelText="Search spools" value={spoolSearch} onChange={(event) => { setSpoolSearch(event.currentTarget.value); setSpoolPage(1); form.setValue('spoolId', ''); }} /><Select id="mount-spool" labelText="Active, unmounted spool" invalid={!!form.formState.errors.spoolId} invalidText="Select a spool." {...form.register('spoolId', { required: true })}><SelectItem value="" text="Select a spool" />{spools.data?.items.filter((spool) => !spool.mounted).map((spool) => <SelectItem key={spool.id} value={spool.id} text={`${spool.displayId} · ${spool.materialName} · ${spool.remainingQuantity} ${spool.unit}`} />)}</Select>{spools.data && <Pagination page={spoolPage} pageSize={25} pageSizes={[25]} totalItems={spools.data.total} onChange={({ page }) => { form.setValue('spoolId', ''); setSpoolPage(page); }} />}{spools.isError && <ErrorState message="Spools could not be loaded." onRetry={() => spools.refetch()} />}</>}
      {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Printer configuration was not updated" subtitle="The slot or spool may have changed. Your inputs have been retained; verify the selection and retry." />}
    </Stack></CatalogFormModal>}
    <UnsavedChangesDialog guard={guard} />
    <DestructiveActionDialog open={disableOpen} title="Disable printer profile?" confirmLabel="Disable profile" pending={configure.isPending} error={configure.isError ? 'The profile could not be disabled. Reload and retry with its current version.' : undefined} onClose={() => setDisableOpen(false)} onConfirm={() => configure.mutate(false)}>New print submissions will no longer be accepted for this profile. Existing units, slots, assignments and print history are retained.</DestructiveActionDialog>
    <DestructiveActionDialog open={!!unmountTarget} title={`Unmount spool from ${unmountTarget?.name ?? 'slot'}?`} confirmLabel="Unmount spool" pending={unmount.isPending} error={unmount.isError ? 'The assignment changed or could not be removed. Reload and retry.' : undefined} onClose={() => setUnmountTarget(null)} onConfirm={() => { if (unmountTarget) unmount.mutate(unmountTarget.id); }}>The spool will become available to mount elsewhere. Its stock and mounting history are retained.</DestructiveActionDialog>
  </MachinePageShell>;
}
