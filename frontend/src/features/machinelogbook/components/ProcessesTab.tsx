import { useState, type ReactNode } from 'react';
import {
  Button,
  DataTable,
  Dropdown,
  IconButton,
  InlineNotification,
  Modal,
  OverflowMenu,
  OverflowMenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableToolbar,
  TableToolbarContent,
  Tag,
  TextInput,
  Toggle,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import type { Process, ProcessIntegration, ProcessMeasure } from '../../../api/generated/models';
import { createProcess, updateProcess } from '../../../api/generated/machines/machines';
import { ApiError } from '../../../api/http-client';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator } from '../../../app/decimalInput';
import { EmptyState } from '../../../app/PageState';
import { integrationLabel, measureText } from '../processConfig';
import { machineLogbookKeys, machinesQuery, processesQuery } from '../queries';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import '../styles/machines.scss';

const headers = [
  { key: 'name', header: 'Name' },
  { key: 'integration', header: 'Integration' },
  { key: 'measures', header: 'Measures' },
  { key: 'status', header: 'Status' },
  { key: 'machines', header: 'Machines' },
];

const MEASURE_KEY = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_MEASURES = 20;
const integrations: ProcessIntegration[] = ['none', 'fdm_printer'];

type MeasureRow = { key: string; label: string; unit: string; blockSize: string };
type Values = { name: string; integration: ProcessIntegration; active: boolean; measures: MeasureRow[] };

const rowOf = (measure: ProcessMeasure): MeasureRow => ({
  key: measure.key,
  label: measure.label,
  unit: measure.unit,
  blockSize: decimalText(measure.blockSize),
});

function sameMeasures(a: ProcessMeasure[], b: ProcessMeasure[]) {
  return a.length === b.length && a.every((m, i) => JSON.stringify(m) === JSON.stringify(b[i]));
}

function ProcessModal({
  process,
  processes,
  onClose,
}: {
  process?: Process;
  processes: Process[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const [measureError, setMeasureError] = useState<string | null>(null);
  const {
    control,
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors },
  } = useForm<Values>({
    defaultValues: {
      name: process?.name ?? '',
      integration: process?.integration ?? 'none',
      active: process?.active ?? true,
      measures: (process?.measures ?? []).map(rowOf),
    },
  });
  const { fields, append, remove } = useFieldArray({ control, name: 'measures' });
  const save = useMutation({
    mutationFn: (values: Values) => {
      const measures: ProcessMeasure[] = values.measures.map((row) => ({
        key: row.key.trim(),
        label: row.label.trim(),
        unit: row.unit.trim(),
        blockSize: decimalNumber(row.blockSize, { integer: true })!,
      }));
      const name = values.name.trim();
      if (!process) return createProcess({ name, integration: values.integration, measures });
      return updateProcess(process.id, {
        name,
        integration: values.integration,
        active: values.active,
        // Omitted keeps the stored measures; sending them replaces the list and is checked for use.
        ...(sameMeasures(measures, process.measures) ? {} : { measures }),
        expectedVersion: process.version,
      });
    },
    onSuccess: async (saved) => {
      notify({ kind: 'success', title: process ? 'Process saved' : 'Process added', subtitle: saved.name });
      onClose();
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409 && error.data?.code === 'measure_in_use') {
        setMeasureError(error.message || 'A measure that pricing rules or runs use cannot be removed.');
      } else if (error instanceof ApiError && error.status === 409 && error.data?.code === 'already_exists') {
        setError('name', { message: 'This name is already used.' });
      }
    },
  });
  const pending = save.isPending;
  const submit = handleSubmit((values) => {
    setMeasureError(null);
    save.mutate(values);
  });
  const measureRows = watch('measures');
  const genericError =
    save.isError && !measureError && !(save.error instanceof ApiError && save.error.data?.code === 'already_exists');

  return (
    <Modal
      open
      size="md"
      modalHeading={process ? 'Edit process' : 'Add process'}
      primaryButtonText={pending ? 'Saving…' : process ? 'Save' : 'Add process'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => void submit()}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap={6}>
          <TextInput
            id="process-name"
            labelText="Name"
            autoComplete="off"
            data-modal-primary-focus
            invalid={Boolean(errors.name)}
            invalidText={errors.name?.message}
            {...register('name', {
              validate: (value) => {
                const name = value.trim();
                if (!name) return 'Enter a name.';
                if (name.length > 150) return 'Use at most 150 characters.';
                return processes.some(
                  (item) => item.id !== process?.id && item.name.toLowerCase() === name.toLowerCase(),
                )
                  ? 'This name is already used.'
                  : true;
              },
            })}
          />
          <Controller
            control={control}
            name="integration"
            render={({ field }) => (
              <Dropdown<ProcessIntegration>
                id="process-integration"
                titleText="Integration"
                label="Integration"
                helperText="Only FDM printer processes get a printer setup with a model, a connector and spool inputs."
                items={integrations}
                itemToString={(item) => (item ? integrationLabel(item) : '')}
                selectedItem={field.value}
                onChange={({ selectedItem }) => field.onChange(selectedItem ?? 'none')}
              />
            )}
          />
          {process && (
            <Controller
              control={control}
              name="active"
              render={({ field }) => (
                <Toggle
                  id="process-active"
                  labelText="Active"
                  labelA="Inactive"
                  labelB="Active"
                  toggled={field.value}
                  onToggle={(checked) => field.onChange(checked)}
                />
              )}
            />
          )}
          <fieldset className="mj-measures">
            <legend className="mj-section-title">Measures</legend>
            <p className="mj-secondary">
              Counted values a run of this process records, such as stitches. Pricing rules charge them per block.
            </p>
            {fields.map((field, index) => (
              <div key={field.id} className="mj-measure-row">
                <TextInput
                  id={`process-measure-${index}-key`}
                  labelText="Key"
                  size="sm"
                  autoComplete="off"
                  invalid={Boolean(errors.measures?.[index]?.key)}
                  invalidText={errors.measures?.[index]?.key?.message}
                  {...register(`measures.${index}.key`, {
                    validate: (value) => {
                      const key = value.trim();
                      if (!MEASURE_KEY.test(key))
                        return 'Use 2 to 40 lowercase letters, digits or underscores, starting with a letter.';
                      return measureRows.filter((row, i) => i !== index && row.key.trim() === key).length > 0
                        ? 'This key is used twice.'
                        : true;
                    },
                  })}
                />
                <TextInput
                  id={`process-measure-${index}-label`}
                  labelText="Label"
                  size="sm"
                  autoComplete="off"
                  invalid={Boolean(errors.measures?.[index]?.label)}
                  invalidText={errors.measures?.[index]?.label?.message}
                  {...register(`measures.${index}.label`, {
                    validate: (value) => {
                      const label = value.trim();
                      return !label ? 'Enter a label.' : label.length > 60 ? 'Use at most 60 characters.' : true;
                    },
                  })}
                />
                <TextInput
                  id={`process-measure-${index}-unit`}
                  labelText="Unit"
                  size="sm"
                  autoComplete="off"
                  invalid={Boolean(errors.measures?.[index]?.unit)}
                  invalidText={errors.measures?.[index]?.unit?.message}
                  {...register(`measures.${index}.unit`, {
                    validate: (value) => {
                      const unit = value.trim();
                      return !unit ? 'Enter a unit.' : unit.length > 20 ? 'Use at most 20 characters.' : true;
                    },
                  })}
                />
                <Controller
                  control={control}
                  name={`measures.${index}.blockSize`}
                  rules={{
                    validate: (value) => {
                      const valid = decimalValidator({ integer: true, positive: true })(value);
                      return valid === true ? true : 'Enter a whole number of 1 or more.';
                    },
                  }}
                  render={({ field: block, fieldState }) => (
                    <DecimalField
                      id={`process-measure-${index}-block`}
                      labelText="Block size"
                      size="sm"
                      integer
                      value={block.value}
                      invalid={fieldState.invalid}
                      invalidText={fieldState.error?.message}
                      onChange={block.onChange}
                    />
                  )}
                />
                <IconButton
                  label={`Remove measure ${index + 1}`}
                  kind="ghost"
                  size="sm"
                  onClick={() => {
                    setMeasureError(null);
                    remove(index);
                  }}
                >
                  <TrashCan />
                </IconButton>
              </div>
            ))}
            {measureError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Measure still in use"
                subtitle={measureError}
              />
            )}
            <div>
              <Button
                kind="tertiary"
                size="sm"
                renderIcon={Add}
                disabled={fields.length >= MAX_MEASURES}
                onClick={() => append({ key: '', label: '', unit: '', blockSize: '1' })}
              >
                Add measure
              </Button>
            </div>
          </fieldset>
          {genericError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Process not saved"
              subtitle="Check that the name is unique. If someone else changed this process, close the dialog and reopen it."
            />
          )}
        </Stack>
      </form>
    </Modal>
  );
}

export function ProcessesTab({ switcher }: { switcher?: ReactNode }) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const canManage = can('machines.manage');
  const [dialog, setDialog] = useState<{ process?: Process } | null>(null);
  const processes = useQuery(processesQuery());
  const machines = useQuery(machinesQuery({ pageSize: 100 }));
  const items = processes.data?.items ?? [];
  const count = (id: string) => (machines.data?.items ?? []).filter((machine) => machine.process.id === id).length;
  const patch = useMutation({
    mutationFn: ({ process, ...change }: { process: Process; active?: boolean }) =>
      updateProcess(process.id, { ...change, expectedVersion: process.version }),
    onSuccess: async (saved) => {
      notify({
        kind: 'success',
        subtitle: saved.name,
        title: saved.active ? 'Process activated' : 'Process deactivated',
      });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
    onError: (_error, { process }) =>
      notify({
        kind: 'error',
        title: 'Process not saved',
        subtitle: `${process.name} may have changed. Reload the list and try again.`,
      }),
  });

  return (
    <div className="mj-stack">
      <QueryBoundary query={processes} errorMessage="The processes could not be loaded.">
        <DataTable rows={items.map((item) => ({ id: item.id }))} headers={headers}>
          {({ rows, headers: tableHeaders, getRowProps, getTableProps }) => (
            <TableContainer className="mj-table-container">
              <TableToolbar aria-label="Processes toolbar">
                {switcher}
                <TableToolbarContent>
                  {canManage && (
                    <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setDialog({})}>
                      Add process
                    </Button>
                  )}
                </TableToolbarContent>
              </TableToolbar>
              <Table {...getTableProps()} aria-label="Processes">
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((header) => (
                      <TableHeader key={header.key}>{header.header}</TableHeader>
                    ))}
                    {canManage && <TableHeader aria-label="Actions" />}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((row) => {
                    const process = items.find((item) => item.id === row.id)!;
                    const { key, ...rowProps } = getRowProps({ row });
                    return (
                      <TableRow key={key} {...rowProps}>
                        <TableCell>{process.name}</TableCell>
                        <TableCell>{integrationLabel(process.integration)}</TableCell>
                        <TableCell>
                          {process.measures.length === 0 ? (
                            '—'
                          ) : (
                            <span className="mj-inline">
                              {process.measures.map((measure) => (
                                <Tag key={measure.key} size="sm" type="gray">
                                  {measureText(measure)}
                                </Tag>
                              ))}
                            </span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Tag size="sm" type={process.active ? 'green' : 'gray'}>
                            {process.active ? 'Active' : 'Inactive'}
                          </Tag>
                        </TableCell>
                        <TableCell>{machines.isSuccess ? count(process.id) : '—'}</TableCell>
                        {canManage && (
                          <TableCell className="cds--table-column-menu">
                            <OverflowMenu
                              aria-label={`Actions for ${process.name}`}
                              iconDescription={`Actions for ${process.name}`}
                              flipped
                              size="sm"
                            >
                              <OverflowMenuItem itemText="Edit" onClick={() => setDialog({ process })} />
                              <OverflowMenuItem
                                itemText={process.active ? 'Deactivate' : 'Activate'}
                                disabled={patch.isPending}
                                onClick={() => patch.mutate({ process, active: !process.active })}
                              />
                            </OverflowMenu>
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {items.length === 0 && (
                <EmptyState title="No processes yet" description="Add a process to start adding machines." />
              )}
            </TableContainer>
          )}
        </DataTable>
      </QueryBoundary>
      <p className="mj-secondary">Inactive processes stay on existing machines but can't be chosen for new ones.</p>
      {dialog && (
        <ProcessModal
          key={dialog.process?.id ?? 'new'}
          process={dialog.process}
          processes={items}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
