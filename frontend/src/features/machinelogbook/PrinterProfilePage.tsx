import { Add, Connect } from '@carbon/icons-react';
import { Button, InlineNotification, Modal, Select, SelectItem, Stack, Tag, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useParams } from 'react-router-dom';
import { configurePrinterProfile, createPrinterInputUnit, createPrinterSlot, mountPrinterSpool, unmountPrinterSpool } from '../../api/generated/printing/printing';
import { PageShell } from '../../app/PageShell';
import { FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { machineLogbookKeys, machinesQuery, printerQuery, spoolsQuery } from './queries';

type Dialog = 'unit' | 'slot' | 'mount' | null;
type Fields = { name: string; position: number; externalIdentifier: string; inputUnitId: string; status: 'available' | 'unavailable' | 'retired'; spoolId: string };

export function PrinterProfilePage() {
  const { machineId = '' } = useParams();
  const currentUser = useCurrentUser();
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedSlotId, setSelectedSlotId] = useState('');
  const form = useForm<Fields>({ defaultValues: { position: 0, status: 'available' } });
  const profile = useQuery(printerQuery(machineId));
  const machines = useQuery(machinesQuery({ page: 1, pageSize: 100 }));
  const spools = useQuery({ ...spoolsQuery({ lifecycle: 'active', page: 1, pageSize: 100 }), enabled: dialog === 'mount' });
  const refresh = async () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const configure = useMutation({ mutationFn: () => configurePrinterProfile(machineId, { enabled: true, expectedVersion: 0 }), onSuccess: refresh });
  const mutation = useMutation<unknown, Error, Fields>({
    mutationFn: (values: Fields) => {
      if (dialog === 'unit') return createPrinterInputUnit(machineId, { name: values.name, position: Number(values.position), externalIdentifier: values.externalIdentifier || null });
      if (dialog === 'slot') return createPrinterSlot(values.inputUnitId, { name: values.name, position: Number(values.position), status: values.status, externalIdentifier: values.externalIdentifier || null });
      return mountPrinterSpool(selectedSlotId, { spoolId: values.spoolId });
    },
    onSuccess: async () => { setDialog(null); form.reset({ position: 0, status: 'available' }); await refresh(); },
  });
  const unmount = useMutation({ mutationFn: (slotId: string) => unmountPrinterSpool(slotId), onSuccess: refresh });
  const canConfigure = hasPermission(currentUser, PermissionId.machinesmanage);
  const canAssign = hasPermission(currentUser, PermissionId.printer_slotsassign);
  const machineName = machines.data?.items.find((machine) => machine.id === machineId)?.name ?? 'Printer';

  if (profile.isPending || machines.isPending) return <FullPageLoading label="Loading printer configuration" />;
  if (profile.isError) return <PageShell title={machineName} description="This machine does not have a generic printer profile yet." breadcrumbs={[{ label: 'Machines', to: '/machine-logbook/machines' }, { label: machineName }]} actions={canConfigure ? <Button onClick={() => configure.mutate()} disabled={configure.isPending}>Configure as printer</Button> : undefined}><Tile><h2>Printer topology</h2><p>Create a printer profile before adding input units and filament slots.</p>{configure.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Printer profile not created" />}</Tile></PageShell>;
  const item = profile.data;
  return <PageShell
    title={item.machineName}
    description="Generic filament input topology and current physical spool assignments."
    breadcrumbs={[{ label: 'Machines', to: '/machine-logbook/machines' }, { label: item.machineName }]}
    actions={canConfigure ? <Button renderIcon={Add} onClick={() => setDialog('unit')}>Add input unit</Button> : undefined}
    width="wide"
    className="machine-logbook-page detail-page"
  >
    <div className="detail-grid">
      {item.inputUnits.map((unit) => <Tile key={unit.id}><div className="section-heading"><div><h2>{unit.name}</h2><p className="section-description">{unit.externalIdentifier || 'No external identifier'}</p></div>{canConfigure && <Button kind="ghost" size="sm" onClick={() => { form.setValue('inputUnitId', unit.id); setDialog('slot'); }}>Add slot</Button>}</div>
        <Stack gap={4}>{item.slots.filter((slot) => slot.inputUnitId === unit.id).map((slot) => <Tile key={slot.id}><div className="section-heading"><div><strong>{slot.name}</strong><div><Tag type={slot.status === 'available' ? 'green' : 'gray'}>{slot.status}</Tag>{slot.spoolDisplayId && <Tag type="blue">{slot.spoolDisplayId}</Tag>}</div></div>{canAssign && (slot.spoolId ? <Button kind="danger--tertiary" size="sm" disabled={unmount.isPending} onClick={() => unmount.mutate(slot.id)}>Unmount</Button> : <Button kind="tertiary" size="sm" renderIcon={Connect} onClick={() => { setSelectedSlotId(slot.id); setDialog('mount'); }}>Mount spool</Button>)}</div></Tile>)}</Stack>
      </Tile>)}
      {item.inputUnits.length === 0 && <Tile><h2>No input units</h2><p>Add a direct feed, multi-material unit, or another physical filament input.</p></Tile>}
    </div>
    <Modal open={dialog !== null} modalHeading={dialog === 'unit' ? 'Add printer input unit' : dialog === 'slot' ? 'Add filament slot' : 'Mount filament spool'} primaryButtonText={mutation.isPending ? 'Saving…' : 'Save'} secondaryButtonText="Cancel" primaryButtonDisabled={mutation.isPending || spools.isPending} onRequestClose={() => setDialog(null)} onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
      <Stack gap={5}>
        {(dialog === 'unit' || dialog === 'slot') && <><TextInput id="topology-name" labelText="Name" {...form.register('name', { required: true })} /><TextInput id="topology-position" type="number" labelText="Position" {...form.register('position', { valueAsNumber: true, required: true })} /><TextInput id="topology-external" labelText="External identifier" {...form.register('externalIdentifier')} /></>}
        {dialog === 'slot' && <Select id="slot-status" labelText="Status" {...form.register('status')}><SelectItem value="available" text="Available" /><SelectItem value="unavailable" text="Unavailable" /><SelectItem value="retired" text="Retired" /></Select>}
        {dialog === 'mount' && <Select id="mount-spool" labelText="Active, unmounted spool" {...form.register('spoolId', { required: true })}><SelectItem value="" text="Select a spool" />{spools.data?.items.filter((spool) => !spool.mounted).map((spool) => <SelectItem key={spool.id} value={spool.id} text={`${spool.displayId} · ${spool.materialName} · ${spool.remainingQuantity} ${spool.unit}`} />)}</Select>}
        {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Printer configuration was not updated" subtitle="The slot or spool may have changed. Reload and retry." />}
      </Stack>
    </Modal>
  </PageShell>;
}
