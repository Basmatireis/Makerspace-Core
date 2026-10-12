import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { Modal, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, TextInput, Toggle } from '@carbon/react';
import { useSimulatedMutation, useStore } from '../store';
import type { Machine, MachineStatus } from '../types';

type Values = { name: string; machineTypeId: string; status: MachineStatus; externalIdentifier: string; automaticCollectionEnabled: boolean };

const statusOptions: { value: MachineStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'retired', label: 'Retired' },
];

export function MachineFormModal({ open, onClose, machine }: { open: boolean; onClose: () => void; machine?: Machine }) {
  const store = useStore();
  const { mutate, pending } = useSimulatedMutation(store.saveMachine);
  const types = store.machineTypes.filter((type) => type.active || type.id === machine?.machineTypeId);
  const defaults = (): Values => ({
    name: machine?.name ?? '',
    machineTypeId: machine?.machineTypeId ?? '',
    status: machine?.status ?? 'active',
    externalIdentifier: machine?.externalIdentifier ?? '',
    automaticCollectionEnabled: machine?.automaticCollectionEnabled ?? false,
  });
  const { control, register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ defaultValues: defaults() });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) reset(defaults()); }, [open, machine?.id]);

  const submit = handleSubmit(async (values) => {
    const saved = await mutate({
      id: machine?.id,
      name: values.name.trim(),
      machineTypeId: values.machineTypeId,
      status: values.status,
      externalIdentifier: values.externalIdentifier.trim() || null,
      automaticCollectionEnabled: values.automaticCollectionEnabled,
    });
    store.notify({ kind: 'success', title: machine ? 'Machine saved' : 'Machine added', subtitle: saved.name });
    onClose();
  });

  return (
    <Modal
      open={open}
      size="sm"
      modalHeading={machine ? 'Edit machine' : 'Add machine'}
      primaryButtonText={pending ? 'Saving…' : machine ? 'Save machine' : 'Add machine'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }}
      onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <Stack gap={6}>
          <TextInput
            id="machine-name" labelText="Name" autoComplete="off"
            invalid={Boolean(errors.name)} invalidText={errors.name?.message}
            {...register('name', { validate: (value) => value.trim() ? true : 'Enter a machine name.' })}
          />
          <Select
            id="machine-type" labelText="Machine type" helperText="Inactive types are hidden here; manage them from the Machines page."
            invalid={Boolean(errors.machineTypeId)} invalidText={errors.machineTypeId?.message}
            {...register('machineTypeId', { required: 'Choose a machine type.' })}
          >
            <SelectItem value="" text="Choose a type" />
            {types.map((type) => <SelectItem key={type.id} value={type.id} text={type.active ? type.name : `${type.name} (inactive)`} />)}
          </Select>
          <Controller
            control={control} name="status"
            render={({ field }) => (
              <RadioButtonGroup
                legendText="Status" name="machine-status" orientation="vertical" valueSelected={field.value}
                helperText="Status is administrative. Only Retired blocks new jobs and automatic ingest; Active and Maintenance both still accept them."
                onChange={(value) => field.onChange(value)}
              >
                {statusOptions.map((option) => <RadioButton key={option.value} id={`machine-status-${option.value}`} value={option.value} labelText={option.label} />)}
              </RadioButtonGroup>
            )}
          />
          <TextInput id="machine-external" labelText="External identifier (optional)" helperText="Serial number or ID used by the machine's connector." autoComplete="off" {...register('externalIdentifier')} />
          <Controller
            control={control} name="automaticCollectionEnabled"
            render={({ field }) => (
              <Toggle
                id="machine-auto" labelText="Automatic collection" labelA="Off" labelB="On" toggled={field.value}
                onToggle={(checked) => field.onChange(checked)}
              />
            )}
          />
        </Stack>
      </form>
    </Modal>
  );
}
