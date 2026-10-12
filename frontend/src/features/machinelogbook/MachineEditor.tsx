import { CatalogFormModal } from './CatalogFormModal';
import { useLatestCallback } from '../../app/useLatestCallback';
import { InlineNotification, Select, SelectItem, Stack, TextInput, Toggle } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import type { CreateMachineRequest, Machine, MachineType } from '../../api/generated/models';
import { createMachine, createMachineType, updateMachine, updateMachineType } from '../../api/generated/machines/machines';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { machineLogbookKeys, machineTypesQuery } from './queries';

export function MachineEditor({ machine, onClose }: { machine?: Machine; onClose: () => void }) {
  const client = useQueryClient();
  const types = useQuery(machineTypesQuery());
  const form = useForm<CreateMachineRequest>({ defaultValues: machine ? { name: machine.name, machineTypeId: machine.machineType.id, status: machine.status, automaticCollectionEnabled: machine.automaticCollectionEnabled, externalIdentifier: machine.externalIdentifier ?? '' } : { name: '', machineTypeId: '', status: 'active', automaticCollectionEnabled: false, externalIdentifier: '' } });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty, onDiscard: onClose });
  const mutation = useMutation({ mutationFn: (values: CreateMachineRequest) => {
    const input = { ...values, externalIdentifier: values.automaticCollectionEnabled ? values.externalIdentifier || null : null };
    return machine ? updateMachine(machine.id, { ...input, expectedVersion: machine.version }) : createMachine(input);
  }, onSuccess: async () => { form.reset(); onClose(); await client.invalidateQueries({ queryKey: machineLogbookKeys.all }); } });
  const close = useLatestCallback(() => { if (!mutation.isPending) guard.requestDiscard(onClose); });
  const availableTypes = types.data?.items.filter((type) => type.active || type.id === machine?.machineType.id) ?? [];
  return <><CatalogFormModal open={!guard.dialogOpen} selectorPrimaryFocus="#machine-name" modalHeading={machine ? 'Edit machine' : 'Add machine'} primaryButtonText={mutation.isPending ? 'Saving…' : 'Save machine'} secondaryButtonText="Cancel" primaryButtonDisabled={mutation.isPending || types.isPending || types.isError} preventCloseOnClickOutside onRequestClose={close} onRequestSubmit={form.handleSubmit((values) => { if (!mutation.isPending && types.isSuccess) mutation.mutate(values); })}><Stack gap={5}>
    <TextInput id="machine-name" labelText="Name" invalid={!!form.formState.errors.name} invalidText="Enter a name (up to 150 characters)." {...form.register('name', { required: true, maxLength: 150, validate: (value) => !!value.trim() })} />
    <Select id="machine-type" labelText="Machine type" value={form.watch('machineTypeId')} invalid={!!form.formState.errors.machineTypeId} invalidText="Select a machine type." {...form.register('machineTypeId', { required: true })}><SelectItem value="" text="Select a type" />{availableTypes.map((type) => <SelectItem key={type.id} value={type.id} text={`${type.name}${type.active ? '' : ' (inactive)'}`} />)}</Select>
    {types.isError && <InlineNotification kind="error" hideCloseButton title="Machine types could not be loaded" subtitle="Close and reopen this dialog to retry." />}
    <Select id="machine-status" labelText="Administrative status" {...form.register('status')}><SelectItem value="active" text="Active" /><SelectItem value="maintenance" text="Maintenance" /><SelectItem value="retired" text="Retired" /></Select>
    {form.watch('status') === 'retired' && <p>Retiring a machine removes it from new work selection. Existing jobs and its history remain available.</p>}
    <Controller control={form.control} name="automaticCollectionEnabled" render={({ field }) => <Toggle id="automatic-collection" labelText="Automatic collection" labelA="Disabled" labelB="Enabled" toggled={field.value} onToggle={field.onChange} />} />
    <TextInput id="external-identifier" labelText="External identifier" disabled={!form.watch('automaticCollectionEnabled')} helperText="Used when automatic collection is enabled." {...form.register('externalIdentifier', { maxLength: 200 })} />
    {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Machine not saved" subtitle="Check the values and unique name. If another person changed this machine, close and reopen the editor after reloading. Your inputs have been retained." />}
  </Stack></CatalogFormModal><UnsavedChangesDialog guard={guard} /></>;
}

export function MachineTypeEditor({ type, onClose }: { type?: MachineType; onClose: () => void }) {
  const client = useQueryClient();
  const form = useForm<{ name: string; active: boolean }>({ defaultValues: { name: type?.name ?? '', active: type?.active ?? true } });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty, onDiscard: onClose });
  const mutation = useMutation({ mutationFn: (values: { name: string; active: boolean }) => type ? updateMachineType(type.id, { ...values, expectedVersion: type.version }) : createMachineType({ name: values.name }), onSuccess: async () => { form.reset(); onClose(); await client.invalidateQueries({ queryKey: machineLogbookKeys.all }); } });
  const close = useLatestCallback(() => { if (!mutation.isPending) guard.requestDiscard(onClose); });
  return <><CatalogFormModal open={!guard.dialogOpen} selectorPrimaryFocus="#machine-type-name" modalHeading={type ? 'Edit machine type' : 'Add machine type'} primaryButtonText={mutation.isPending ? 'Saving…' : 'Save type'} secondaryButtonText="Cancel" primaryButtonDisabled={mutation.isPending} preventCloseOnClickOutside onRequestClose={close} onRequestSubmit={form.handleSubmit((values) => { if (!mutation.isPending) mutation.mutate(values); })}><Stack gap={5}>
    <TextInput id="machine-type-name" labelText="Type name" invalid={!!form.formState.errors.name} invalidText="Enter a type name (up to 120 characters)." {...form.register('name', { required: true, maxLength: 120, validate: (value) => !!value.trim() })} />
    {type && <Controller control={form.control} name="active" render={({ field }) => <Toggle id="machine-type-active" labelText="Available for new machines" labelA="Inactive" labelB="Active" toggled={field.value} onToggle={field.onChange} />} />}
    {type && <p>Inactive types cannot be chosen for new machines. Existing machines and their history remain available.</p>}
    {mutation.isError && <InlineNotification kind="error" hideCloseButton title="Machine type not saved" subtitle="Check the unique name and current version. Your inputs have been retained." />}
  </Stack></CatalogFormModal><UnsavedChangesDialog guard={guard} /></>;
}
