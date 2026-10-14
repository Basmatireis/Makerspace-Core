import { useState } from 'react';
import { Button, RadioButton, RadioButtonGroup, RadioTile, Select, SelectItem, Stack, TextInput, TileGroup } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { Controller } from 'react-hook-form';
import { printerModels } from '../../mockData';
import { isPrinterType } from '../../printerSetup';
import { useStore } from '../../store';
import type { MachineStatus, PrinterModelId } from '../../types';
import type { SetupForm, WizardMachine } from './wizardTypes';

const statusOptions: { value: MachineStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'retired', label: 'Retired' },
];

export function MachineStep({ form, machine, onModelChange }: { form: SetupForm; machine: WizardMachine; onModelChange: (modelId: PrinterModelId) => void }) {
  const store = useStore();
  const { control, register, setValue, watch, formState: { errors } } = form;
  const [adding, setAdding] = useState(false);
  const [newType, setNewType] = useState('');
  const typeId = watch('machineTypeId');
  const types = store.machineTypes.filter((type) => type.active || type.id === machine?.machineTypeId);
  const selectedType = store.machineTypes.find((type) => type.id === typeId);
  const trimmed = newType.trim();
  const taken = Boolean(trimmed) && store.machineTypes.some((type) => type.name.toLowerCase() === trimmed.toLowerCase());

  const addType = () => {
    if (!trimmed || taken) return;
    const created = store.saveMachineType({ name: trimmed, active: true });
    store.notify({ kind: 'success', title: 'Machine type added', subtitle: created.name });
    setValue('machineTypeId', created.id, { shouldValidate: true });
    setNewType('');
    setAdding(false);
  };

  return (
    <Stack gap={6}>
      <TextInput
        id="setup-name" labelText="Name" autoComplete="off" invalid={Boolean(errors.name)} invalidText={errors.name?.message}
        {...register('name', { validate: (value) => value.trim() ? true : 'Enter a machine name.' })}
      />
      <div>
        <Select
          id="setup-type" labelText="Machine type" helperText="Inactive types stay on existing machines but can't be chosen for new ones."
          invalid={Boolean(errors.machineTypeId)} invalidText={errors.machineTypeId?.message}
          {...register('machineTypeId', { required: 'Choose a machine type.' })}
        >
          <SelectItem value="" text="Choose a type" />
          {types.map((type) => <SelectItem key={type.id} value={type.id} text={type.active ? type.name : `${type.name} (inactive)`} />)}
        </Select>
        {store.can('machines.manage') && !adding && <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setAdding(true)}>New type</Button>}
        {adding && (
          <div className="mj-inline-form">
            <TextInput
              id="setup-new-type" labelText="New type name" size="sm" value={newType} autoComplete="off" invalid={taken} invalidText="This name is already used."
              onChange={(event) => setNewType(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addType(); } }}
            />
            <span className="mj-inline">
              <Button kind="tertiary" size="sm" disabled={!trimmed || taken} onClick={addType}>Add</Button>
              <Button kind="ghost" size="sm" onClick={() => { setAdding(false); setNewType(''); }}>Cancel</Button>
            </span>
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
      {isPrinterType(selectedType) && (
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
