import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, RadioButton, RadioButtonGroup, Stack, TextArea } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { TrainingRecord, TrainingStatus } from '../../api/generated/models';
import { setPersonTrainingRecord } from '../../api/generated/trainings/trainings';
import { ApiError } from '../../api/http-client';
import { DateInput } from '../../app/DateInput';
import { trainingKeys, trainingStatusLabels } from './queries';

type Values = { status: TrainingStatus; completedOn: string; notes: string };

const statuses: TrainingStatus[] = ['not_trained', 'trained', 'trainer'];

function saveError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.data?.code === 'stale_write') return 'Someone else changed this status. Close the dialog and try again.';
    if (error.data?.code === 'training_inactive')
      return 'This training is inactive: you can remove the status or correct its date and notes, but not change it.';
    if (error.data?.code === 'training_record_self')
      return 'Changing the own training status needs its own permission.';
    if (error.status === 422) return 'Check the date: it cannot lie in the future.';
  }
  return 'Check your connection and try again.';
}

/** Sets one person's status for one training: a single three-state choice, plus date and internal notes. */
export function TrainingRecordModal({
  personId,
  record,
  onClose,
}: {
  personId: string;
  record: TrainingRecord;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const { control, handleSubmit, watch } = useForm<Values>({
    defaultValues: { status: record.status, completedOn: record.completedOn ?? '', notes: record.notes ?? '' },
  });
  const status = watch('status');
  const save = useMutation({
    mutationFn: (values: Values) =>
      setPersonTrainingRecord(personId, record.trainingId, {
        status: values.status,
        ...(values.status === 'not_trained'
          ? {}
          : { completedOn: values.completedOn || null, notes: values.notes.trim() || null }),
        expectedVersion: record.version ?? null,
      }),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: trainingKeys.records(personId) }),
        client.invalidateQueries({ queryKey: trainingKeys.catalogue() }),
        // Open days derive their planned competencies from these records.
        client.invalidateQueries({ queryKey: ['open-days'] }),
        client.invalidateQueries({ queryKey: ['dashboard'] }),
      ]);
      onClose();
    },
  });
  const submit = handleSubmit((values) => save.mutate(values));

  return (
    <Modal
      open
      size="sm"
      modalHeading={record.trainingName}
      modalLabel="Training status"
      primaryButtonText={save.isPending ? 'Saving…' : 'Save'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={save.isPending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!save.isPending) onClose();
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
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Status not saved"
              subtitle={saveError(save.error)}
            />
          )}
          <Controller
            control={control}
            name="status"
            render={({ field }) => (
              <RadioButtonGroup
                legendText="Status"
                name="training-status"
                orientation="vertical"
                valueSelected={field.value}
                onChange={(value) => field.onChange(value as TrainingStatus)}
                helperText="Can train others includes being trained. Open days show only the competency, never who trains."
              >
                {statuses.map((value) => (
                  <RadioButton
                    key={value}
                    id={`training-status-${value}`}
                    labelText={trainingStatusLabels[value]}
                    value={value}
                    disabled={!record.trainingActive && value !== 'not_trained' && value !== record.status}
                  />
                ))}
              </RadioButtonGroup>
            )}
          />
          {status !== 'not_trained' && (
            <>
              <Controller
                control={control}
                name="completedOn"
                render={({ field }) => (
                  <DateInput
                    id="training-completed-on"
                    labelText="Completed on (optional)"
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
              <Controller
                control={control}
                name="notes"
                rules={{ maxLength: { value: 2000, message: 'Notes are limited to 2000 characters.' } }}
                render={({ field, fieldState }) => (
                  <TextArea
                    id="training-notes"
                    labelText="Internal notes (optional)"
                    helperText="Visible to people who manage training records, not to the person."
                    rows={3}
                    maxCount={2000}
                    enableCounter
                    invalid={Boolean(fieldState.error)}
                    invalidText={fieldState.error?.message}
                    {...field}
                  />
                )}
              />
            </>
          )}
        </Stack>
      </form>
    </Modal>
  );
}
