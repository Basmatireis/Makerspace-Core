import { useState } from 'react';
import { Button, Checkbox, InlineNotification, RadioButton, RadioButtonGroup, RadioTile, Select, SelectItem, Stack, TextInput, TileGroup, Toggle } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useWatch } from 'react-hook-form';
import type { MachineStatus } from '../../../../api/generated/models';
import { createMachineType } from '../../../../api/generated/machines/machines';
import { machineLogbookKeys, machineTypesQuery } from '../../queries';
import { printerModels, type PrinterModelId } from '../../printerSetup';
import { useNotify } from '../../shared/toasts';
import { useCan } from '../../shared/useCan';
import type { SetupForm, WizardMachine } from './wizardTypes';

const statusOptions: { value: MachineStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'retired', label: 'Retired' },
];

export function MachineStep({ form, machine, onModelChange }: { form: SetupForm; machine: WizardMachine; onModelChange: (modelId: PrinterModelId) => void }) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const { control, register, setValue, formState: { errors } } = form;
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState('');
  const [newPrinter, setNewPrinter] = useState(false);
  const typesQuery = useQuery(machineTypesQuery());
  const allTypes = typesQuery.data?.items ?? [];
  const typeId = useWatch({ control, name: 'machineTypeId' });
  const automatic = useWatch({ control, name: 'automaticCollectionEnabled' });
  const types = allTypes.filter((type) => type.active || type.id === machine?.machineType.id);
  const selectedType = allTypes.find((type) => type.id === typeId);
  const trimmed = newType.trim();
  const taken = Boolean(trimmed) && allTypes.some((type) => type.name.toLowerCase() === trimmed.toLowerCase());

  const create = useMutation({
    mutationFn: () => createMachineType({ name: trimmed, printer: newPrinter }),
    onSuccess: async (created) => {
      notify({ kind: 'success', title: 'Machine type added', subtitle: created.name });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.machineTypes() });
      setValue('machineTypeId', created.id, { shouldValidate: true });
      setNewType(''); setNewPrinter(false); setAdding(false);
    },
  });
  const addType = () => { if (trimmed && !taken && !create.isPending) create.mutate(); };

  return (
    <Stack gap={6}>
      <TextInput
        id="setup-name" labelText="Name" autoComplete="off" invalid={Boolean(errors.name)} invalidText={errors.name?.message}
        {...register('name', { validate: (value) => !value.trim() ? 'Enter a machine name.' : value.trim().length > 150 ? 'Use at most 150 characters.' : true })}
      />
      <div>
        <Select
          key={typesQuery.isSuccess ? 'loaded' : 'loading'}
          id="setup-type" labelText="Machine type" helperText="Inactive types stay on existing machines but can't be chosen for new ones."
          invalid={Boolean(errors.machineTypeId)} invalidText={errors.machineTypeId?.message}
          {...register('machineTypeId', { required: 'Choose a machine type.' })}
        >
          <SelectItem value="" text="Choose a type" />
          {types.map((type) => <SelectItem key={type.id} value={type.id} text={type.active ? type.name : `${type.name} (inactive)`} />)}
        </Select>
        {typesQuery.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Machine types could not be loaded" subtitle="Close and reopen this dialog to retry." />}
        {can('machines.manage') && !adding && <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setAdding(true)}>New type</Button>}
        {adding && (
          <div className="mj-inline-form">
            <TextInput
              id="setup-new-type" labelText="New type name" size="sm" value={newType} autoComplete="off" invalid={taken} invalidText="This name is already used."
              onChange={(event) => setNewType(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addType(); } }}
            />
            <span className="mj-inline">
              <Checkbox id="setup-new-type-printer" labelText="Printer type" checked={newPrinter} onChange={(_event, { checked }) => setNewPrinter(checked)} />
              <Button kind="tertiary" size="sm" disabled={!trimmed || taken || create.isPending} onClick={addType}>Add</Button>
              <Button kind="ghost" size="sm" onClick={() => { setAdding(false); setNewType(''); }}>Cancel</Button>
            </span>
            {create.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Machine type not added" subtitle="Check that the name is unique and try again." />}
          </div>
        )}
      </div>
      <Controller
        control={control} name="status"
        render={({ field }) => (
          <RadioButtonGroup
            legendText="Status" name="setup-status" orientation="vertical" valueSelected={field.value}
            helperText="Status is administrative. Only Retired blocks new jobs and automatic ingest; Active and Maintenance both still accept them."
            onChange={(value) => field.onChange(value)}
          >
            {statusOptions.map((option) => <RadioButton key={option.value} id={`setup-status-${option.value}`} value={option.value} labelText={option.label} />)}
          </RadioButtonGroup>
        )}
      />
      <Controller
        control={control} name="automaticCollectionEnabled"
        render={({ field }) => <Toggle id="setup-auto" labelText="Automatic collection" labelA="Off" labelB="On" toggled={field.value} onToggle={(checked) => field.onChange(checked)} />}
      />
      <TextInput
        id="setup-external" labelText="External identifier (optional)" autoComplete="off" disabled={!automatic}
        helperText="Serial number or ID used by the machine's connector. Needs automatic collection."
        {...register('externalIdentifier', { maxLength: 200 })}
      />
      {selectedType?.printer && (
        <Controller
          control={control} name="modelId"
          render={({ field }) => (
            <div>
              <TileGroup<string> legend="Model" name="setup-model" className="mj-tile-grid" valueSelected={field.value} onChange={(value) => { field.onChange(value); onModelChange(value as PrinterModelId); }}>
                {printerModels.map((model) => (
                  <RadioTile key={model.id} id={`setup-model-${model.id}`} value={model.id}>
                    <span className="mj-tile-title">{model.label}</span>
                    <span className="mj-secondary">{model.description}</span>
                  </RadioTile>
                ))}
              </TileGroup>
              <p className="mj-secondary">The model sets up the spool inputs and the printer adapter. Choose one to continue.</p>
            </div>
          )}
        />
      )}
    </Stack>
  );
}
