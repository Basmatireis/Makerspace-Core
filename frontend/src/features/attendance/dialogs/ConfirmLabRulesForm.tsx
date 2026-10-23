import {
  Button,
  Checkbox,
  Form,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { confirmLaborordnungRequest } from '../../../api/generated/laborordnung/laborordnung';
import type { AttendanceHold } from '../../../api/generated/models';
import { DateInput } from '../../../app/DateInput';
import { attendanceKeys, laborordnungKeys } from '../queries';
import { labRulesProblem } from '../presentation';

type FormValues = { reference: string; signedDate: string; archiveNote: string; seen: boolean };

// Header, body and footer of the Lab Rules confirmation step. Confirming also completes the held check-in server-side.
export function ConfirmLabRulesForm({
  hold,
  onCancel,
  onDone,
}: {
  hold: AttendanceHold;
  onCancel: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const { register, control, handleSubmit, watch } = useForm<FormValues>({
    defaultValues: { reference: '', signedDate: '', archiveNote: '', seen: false },
  });
  const ready = watch('reference').trim() !== '' && watch('seen');
  const revision = hold.requiredRevision ?? 'current';
  const confirm = useMutation({
    mutationFn: (values: FormValues) =>
      confirmLaborordnungRequest(hold.laborordnungRequestId!, {
        physicalDocumentReference: values.reference.trim(),
        signedDate: values.signedDate || null,
        archiveNote: values.archiveNote.trim() || null,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: attendanceKeys.all }),
        queryClient.invalidateQueries({ queryKey: laborordnungKeys.all }),
      ]);
      onDone();
    },
  });

  return (
    <>
      <ModalHeader label="Held check-in" title={`Confirm Lab Rules for ${hold.displayName}`} />
      <ModalBody>
        <Form id="confirm-lab-rules-form" onSubmit={handleSubmit((values) => confirm.mutate(values))}>
          <Stack gap={5}>
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Lab Rules not signed"
              subtitle={`${labRulesProblem(hold)}. ${hold.displayName} can only be checked in after you confirm the signed paper copy of revision ${revision}.`}
            />
            <TextInput
              id="lab-rules-reference"
              labelText="Physical document reference"
              helperText="For example the folder and page number of the signed copy."
              maxLength={255}
              {...register('reference')}
            />
            <Controller
              control={control}
              name="signedDate"
              render={({ field }) => (
                <DateInput
                  id="lab-rules-signed"
                  labelText="Signed date (optional)"
                  value={field.value}
                  onChange={field.onChange}
                />
              )}
            />
            <TextArea
              id="lab-rules-note"
              labelText="Archive note (optional)"
              rows={2}
              maxLength={1000}
              {...register('archiveNote')}
            />
            <Controller
              control={control}
              name="seen"
              render={({ field }) => (
                <Checkbox
                  id="lab-rules-seen"
                  labelText={`I have seen ${hold.displayName}'s signature on revision ${revision}.`}
                  checked={field.value}
                  onChange={(_, { checked }) => field.onChange(checked)}
                />
              )}
            />
            {confirm.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Lab Rules not confirmed"
                subtitle={confirm.error.message}
              />
            )}
          </Stack>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={confirm.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" form="confirm-lab-rules-form" disabled={!ready || confirm.isPending}>
          {confirm.isPending ? 'Confirming…' : 'Confirm and check in'}
        </Button>
      </ModalFooter>
    </>
  );
}
