import { useState } from 'react';
import {
  Button,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  RadioTile,
  Select,
  SelectItem,
  Stack,
  TextInput,
  TileGroup,
  Toggle,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useWatch } from 'react-hook-form';
import type { MachineStatus, ProcessIntegration } from '../../../../api/generated/models';
import { createProcess } from '../../../../api/generated/machines/machines';
import { machineLogbookKeys, processesQuery } from '../../queries';
import { integrationLabel, isFdm } from '../../processConfig';
import { printerModels, type PrinterModelId } from '../../printerSetup';
import { useNotify } from '../../shared/toasts';
import { useCan } from '../../shared/useCan';
import type { SetupForm, WizardMachine } from './wizardTypes';

const statusOptions: { value: MachineStatus; label: string }[] = [
  { value: 'active', label: 'Active' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'retired', label: 'Retired' },
];

export function MachineStep({
  form,
  machine,
  onModelChange,
}: {
  form: SetupForm;
  machine: WizardMachine;
  onModelChange: (modelId: PrinterModelId) => void;
}) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const {
    control,
    register,
    setValue,
    formState: { errors },
  } = form;
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIntegration, setNewIntegration] = useState<ProcessIntegration>('none');
  const processesQ = useQuery(processesQuery());
  const allProcesses = processesQ.data?.items ?? [];
  const processId = useWatch({ control, name: 'processId' });
  const automatic = useWatch({ control, name: 'automaticCollectionEnabled' });
  const processes = allProcesses.filter((item) => item.active || item.id === machine?.process.id);
  const selected = allProcesses.find((item) => item.id === processId);
  const trimmed = newName.trim();
  const taken = Boolean(trimmed) && allProcesses.some((item) => item.name.toLowerCase() === trimmed.toLowerCase());

  const create = useMutation({
    mutationFn: () => createProcess({ name: trimmed, integration: newIntegration }),
    onSuccess: async (created) => {
      notify({ kind: 'success', title: 'Process added', subtitle: created.name });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.processes() });
      setValue('processId', created.id, { shouldValidate: true });
      setNewName('');
      setNewIntegration('none');
      setAdding(false);
    },
  });
  const addProcess = () => {
    if (trimmed && !taken && !create.isPending) create.mutate();
  };

  return (
    <Stack gap={6}>
      <TextInput
        id="setup-name"
        labelText="Name"
        autoComplete="off"
        invalid={Boolean(errors.name)}
        invalidText={errors.name?.message}
        {...register('name', {
          validate: (value) =>
            !value.trim() ? 'Enter a machine name.' : value.trim().length > 150 ? 'Use at most 150 characters.' : true,
        })}
      />
      <div>
        <Select
          key={processesQ.isSuccess ? 'loaded' : 'loading'}
          id="setup-process"
          labelText="Process"
          helperText="Inactive processes stay on existing machines but can't be chosen for new ones."
          invalid={Boolean(errors.processId)}
          invalidText={errors.processId?.message}
          {...register('processId', { required: 'Choose a process.' })}
        >
          <SelectItem value="" text="Choose a process" />
          {processes.map((item) => (
            <SelectItem key={item.id} value={item.id} text={item.active ? item.name : `${item.name} (inactive)`} />
          ))}
        </Select>
        {isFdm(selected) && (
          <p className="mj-secondary">A printer setup is available because this process is an FDM printer.</p>
        )}
        {processesQ.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Processes could not be loaded"
            subtitle="Close and reopen this dialog to retry."
          />
        )}
        {can('machines.manage') && !adding && (
          <Button kind="ghost" size="sm" renderIcon={Add} onClick={() => setAdding(true)}>
            New process
          </Button>
        )}
        {adding && (
          <div className="mj-inline-form">
            <TextInput
              id="setup-new-process"
              labelText="New process name"
              size="sm"
              value={newName}
              autoComplete="off"
              invalid={taken}
              invalidText="This name is already used."
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addProcess();
                }
              }}
            />
            <span className="mj-inline">
              <Select
                id="setup-new-process-integration"
                labelText="Integration"
                size="sm"
                value={newIntegration}
                onChange={(event) => setNewIntegration(event.target.value as ProcessIntegration)}
              >
                {(['none', 'fdm_printer'] as const).map((option) => (
                  <SelectItem key={option} value={option} text={integrationLabel(option)} />
                ))}
              </Select>
              <Button kind="tertiary" size="sm" disabled={!trimmed || taken || create.isPending} onClick={addProcess}>
                Add
              </Button>
              <Button
                kind="ghost"
                size="sm"
                onClick={() => {
                  setAdding(false);
                  setNewName('');
                }}
              >
                Cancel
              </Button>
            </span>
            {create.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Process not added"
                subtitle="Check that the name is unique and try again."
              />
            )}
          </div>
        )}
      </div>
      <Controller
        control={control}
        name="status"
        render={({ field }) => (
          <RadioButtonGroup
            legendText="Status"
            name="setup-status"
            orientation="vertical"
            valueSelected={field.value}
            helperText="Status is administrative. Only Retired blocks new jobs and automatic ingest; Active and Maintenance both still accept them."
            onChange={(value) => field.onChange(value)}
          >
            {statusOptions.map((option) => (
              <RadioButton
                key={option.value}
                id={`setup-status-${option.value}`}
                value={option.value}
                labelText={option.label}
              />
            ))}
          </RadioButtonGroup>
        )}
      />
      <Controller
        control={control}
        name="automaticCollectionEnabled"
        render={({ field }) => (
          <Toggle
            id="setup-auto"
            labelText="Automatic collection"
            labelA="Off"
            labelB="On"
            toggled={field.value}
            onToggle={(checked) => field.onChange(checked)}
          />
        )}
      />
      <TextInput
        id="setup-external"
        labelText="External identifier (optional)"
        autoComplete="off"
        disabled={!automatic}
        // A disabled field greys its helper text below the contrast minimum, so the hint shows only while the field is
        // enabled; the Automatic collection toggle right above explains why it is off.
        helperText={automatic ? "Serial number or ID used by the machine's connector." : undefined}
        {...register('externalIdentifier', { maxLength: 200 })}
      />
      {isFdm(selected) && (
        <Controller
          control={control}
          name="modelId"
          render={({ field }) => (
            <div>
              <TileGroup<string>
                legend="Model"
                name="setup-model"
                className="mj-tile-grid"
                valueSelected={field.value}
                onChange={(value) => {
                  field.onChange(value);
                  onModelChange(value as PrinterModelId);
                }}
              >
                {printerModels.map((model) => (
                  <RadioTile key={model.id} id={`setup-model-${model.id}`} value={model.id}>
                    <span className="mj-tile-title">{model.label}</span>
                    <span className="mj-secondary">{model.description}</span>
                  </RadioTile>
                ))}
              </TileGroup>
              <p className="mj-secondary">
                The model sets up the spool inputs and the printer adapter. Choose one to continue.
              </p>
            </div>
          )}
        />
      )}
    </Stack>
  );
}
