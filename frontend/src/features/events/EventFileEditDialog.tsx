import {
  Button,
  Checkbox,
  ComposedModal,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { updateEventFile } from '../../api/generated/events/events';
import type { EventFile, UpdateEventFileRequest } from '../../api/generated/models';
import { useLatestCallback } from '../../app/useLatestCallback';
import { eventMutationMessage } from './errors';
import { DialogProps } from './eventDialogProps';

type FileValues = { description: string; visibility: EventFile['visibility']; isBanner: boolean };

export function FileEditDialog({
  eventId,
  file,
  open = true,
  onClose,
  onSaved,
  onDirtyChange,
}: DialogProps & { file: EventFile }) {
  const formId = `edit-event-file-${file.id}`;
  const form = useForm<FileValues>({
    defaultValues: { description: file.description ?? '', visibility: file.visibility, isBanner: file.isBanner },
  });
  const isBanner = form.watch('isBanner');
  const mutation = useMutation({
    mutationFn: (value: FileValues) =>
      updateEventFile(eventId, file.id, {
        description: value.description || null,
        visibility: value.isBanner ? 'public' : value.visibility,
        isBanner: value.isBanner,
        expectedVersion: file.version,
      } satisfies UpdateEventFileRequest),
    onSuccess: onSaved,
  });
  useEffect(() => {
    onDirtyChange?.(form.formState.isDirty);
  }, [form.formState.isDirty, onDirtyChange]);
  const close = useLatestCallback(() => {
    if (!mutation.isPending) onClose();
    return false;
  });
  return (
    <ComposedModal open={open} onClose={close} size="sm" preventCloseOnClickOutside>
      <ModalHeader title="Edit file details" />
      <ModalBody>
        <form
          id={formId}
          onSubmit={form.handleSubmit((value) => {
            if (!mutation.isPending) mutation.mutate(value);
          })}
        >
          <Stack gap={5}>
            {mutation.error && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="File not saved"
                subtitle={eventMutationMessage(mutation.error)}
              />
            )}
            <TextInput id={`${formId}-name`} labelText="File" value={file.originalFilename} readOnly />
            <Controller
              name="description"
              control={form.control}
              render={({ field }) => (
                <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)" />
              )}
            />
            <Controller
              name="visibility"
              control={form.control}
              render={({ field }) => (
                <Select {...field} id={`${formId}-visibility`} labelText="Visibility" disabled={isBanner}>
                  <SelectItem value="internal" text="Internal" />
                  <SelectItem value="public" text="Public" />
                </Select>
              )}
            />
            <Controller
              name="isBanner"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  id={`${formId}-banner`}
                  labelText="Use this image as the public Event banner"
                  disabled={!file.contentType.startsWith('image/')}
                  checked={field.value}
                  onChange={(_, data) => {
                    field.onChange(data.checked);
                    if (data.checked) form.setValue('visibility', 'public');
                  }}
                />
              )}
            />
          </Stack>
        </form>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={mutation.isPending} onClick={close}>
          Cancel
        </Button>
        <Button type="submit" form={formId} disabled={mutation.isPending}>
          Save changes
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}
