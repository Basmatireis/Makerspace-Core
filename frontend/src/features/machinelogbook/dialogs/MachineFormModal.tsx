import { useEffect, useRef } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, TextInput, Toggle } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Machine, MachineStatus } from '../../../api/generated/models';
import { createMachine, updateMachine } from '../../../api/generated/machines/machines';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { machineLogbookKeys, machineTypesQuery } from '../queries';
import { useNotify } from '../shared/toasts';

type Values = { name: string; machineTypeId: string; status: MachineStatus; externalIdentifier: string; automaticCollectionEnabled: boolean };

const statusOptions: { value: MachineStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'retired', label: 'Retired' },
];

export function MachineFormModal({ open, onClose, machine }: { open: boolean; onClose: () => void; machine?: Machine }) {
  const client = useQueryClient();
  const notify = useNotify();
  const typesQuery = useQuery({ ...machineTypesQuery(), enabled: open });
  const types = (typesQuery.data?.items ?? []).filter((type) => type.active || type.id === machine?.machineType.id);
  // The version the editor opened with: later background updates never silently replace the draft's base.
  const baseVersion = useRef(machine?.version ?? 0);
  const defaults = (): Values => ({
    name: machine?.name ?? '',
    machineTypeId: machine?.machineType.id ?? '',
    status: machine?.status ?? 'active',
    externalIdentifier: machine?.externalIdentifier ?? '',
    automaticCollectionEnabled: machine?.automaticCollectionEnabled ?? false,
  });
  const { control, register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ defaultValues: defaults() });
  const automatic = useWatch({ control, name: 'automaticCollectionEnabled' });
  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const input = {
        name: values.name.trim(),
        machineTypeId: values.machineTypeId,
        status: values.status,
        // The database only allows an external identifier together with automatic collection.
        externalIdentifier: values.automaticCollectionEnabled ? values.externalIdentifier.trim() || null : null,
        automaticCollectionEnabled: values.automaticCollectionEnabled,
      };
      return machine ? updateMachine(machine.id, { ...input, expectedVersion: baseVersion.current }) : createMachine(input);
    },
    onSuccess: async (saved) => {
      notify({ kind: 'success', title: machine ? 'Machine saved' : 'Machine added', subtitle: saved.name });
      onClose();
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
  });
  const { reset: resetMutation } = mutation;
  useEffect(() => {
    if (!open) return;
    baseVersion.current = machine?.version ?? 0;
    reset(defaults());
    resetMutation();
  }, [open, machine?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = mutation.isPending;
  // Carbon's modal can hold on to an older handler, so the pending check must read the latest state.
  const close = useLatestCallback(() => { if (!mutation.isPending) onClose(); });
  const submit = handleSubmit((values) => { if (!pending) mutation.mutate(values); });

  return (
    <Modal
      open={open}
      size="sm"
      modalHeading={machine ? 'Edit machine' : 'Add machine'}
      primaryButtonText={pending ? 'Saving…' : machine ? 'Save machine' : 'Add machine'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || typesQuery.isPending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={close}
      onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <Stack gap={6}>
          <TextInput
            id="machine-name" labelText="Name" autoComplete="off" data-modal-primary-focus
            invalid={Boolean(errors.name)} invalidText={errors.name?.message}
            {...register('name', { validate: (value) => !value.trim() ? 'Enter a machine name.' : value.trim().length > 150 ? 'Use at most 150 characters.' : true })}
          />
          <Select
            key={typesQuery.isSuccess ? 'loaded' : 'loading'}
            id="machine-type" labelText="Machine type" helperText="Inactive types are hidden here; manage them from the Machines page."
            invalid={Boolean(errors.machineTypeId)} invalidText={errors.machineTypeId?.message}
            {...register('machineTypeId', { required: 'Choose a machine type.' })}
          >
            <SelectItem value="" text="Choose a type" />
            {types.map((type) => <SelectItem key={type.id} value={type.id} text={type.active ? type.name : `${type.name} (inactive)`} />)}
          </Select>
          {typesQuery.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Machine types could not be loaded" subtitle="Close and reopen this dialog to retry." />}
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
          <Controller
            control={control} name="automaticCollectionEnabled"
            render={({ field }) => (
              <Toggle
                id="machine-auto" labelText="Automatic collection" labelA="Off" labelB="On" toggled={field.value}
                onToggle={(checked) => field.onChange(checked)}
              />
            )}
          />
          <TextInput
            id="machine-external" labelText="External identifier (optional)" autoComplete="off" disabled={!automatic}
            helperText="Serial number or ID used by the machine's connector. Needs automatic collection."
            {...register('externalIdentifier', { maxLength: 200 })}
          />
          {mutation.isError && (
            <InlineNotification
              kind="error" lowContrast hideCloseButton title="Machine not saved"
              subtitle="Check the values and that the name is unique. If someone else changed this machine, close the dialog and reopen it. Your inputs have been retained."
            />
          )}
        </Stack>
      </form>
    </Modal>
  );
}
