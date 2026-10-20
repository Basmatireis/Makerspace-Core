import {
  Button,
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
import { updateEventTask } from '../../api/generated/events/events';
import type { EventPersonOption, EventTask, EventTaskList, UpdateEventTaskRequest } from '../../api/generated/models';
import { instantToZonedDateTimeValue } from '../../app/dateTime';
import { useLatestCallback } from '../../app/useLatestCallback';
import { eventMutationMessage } from './errors';
import { toISO } from './format';
import { DialogProps } from './eventDialogProps';

type TaskValues = {
  taskListId: string;
  title: string;
  description: string;
  status: EventTask['status'];
  priority: EventTask['priority'];
  assigneePersonId: string;
  dueAt: string;
};

export function TaskEditDialog({
  eventId,
  task,
  lists,
  people,
  open = true,
  onClose,
  onSaved,
  onDirtyChange,
}: DialogProps & { task: EventTask; lists: EventTaskList[]; people: EventPersonOption[] }) {
  const formId = `edit-event-task-${task.id}`;
  const form = useForm<TaskValues>({
    defaultValues: {
      taskListId: task.taskListId ?? '',
      title: task.title,
      description: task.description ?? '',
      status: task.status,
      priority: task.priority,
      assigneePersonId: task.assigneePersonId ?? '',
      dueAt: task.dueAt ? instantToZonedDateTimeValue(task.dueAt) : '',
    },
  });
  const mutation = useMutation({
    mutationFn: (value: TaskValues) =>
      updateEventTask(eventId, task.id, {
        taskListId: value.taskListId || null,
        title: value.title,
        description: value.description || null,
        status: value.status,
        priority: value.priority,
        assigneePersonId: value.assigneePersonId || null,
        dueAt: value.dueAt ? toISO(value.dueAt) : null,
        sortOrder: task.sortOrder,
        expectedVersion: task.version,
      } satisfies UpdateEventTaskRequest),
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
      <ModalHeader title="Edit task" />
      <ModalBody hasScrollingContent>
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
                title="Task not saved"
                subtitle={eventMutationMessage(mutation.error)}
              />
            )}
            <Controller
              name="title"
              control={form.control}
              rules={{ required: true }}
              render={({ field }) => <TextInput {...field} id={`${formId}-title`} labelText="Title" required />}
            />
            <Controller
              name="description"
              control={form.control}
              render={({ field }) => (
                <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)" />
              )}
            />
            <Controller
              name="taskListId"
              control={form.control}
              render={({ field }) => (
                <Select {...field} id={`${formId}-list`} labelText="Task list">
                  <SelectItem value="" text="Ungrouped" />
                  {lists.map((list) => (
                    <SelectItem key={list.id} value={list.id} text={list.name} />
                  ))}
                </Select>
              )}
            />
            <Controller
              name="assigneePersonId"
              control={form.control}
              render={({ field }) => (
                <Select {...field} id={`${formId}-assignee`} labelText="Assignee">
                  <SelectItem value="" text="Unassigned" />
                  {people.map((person) => (
                    <SelectItem key={person.id} value={person.id} text={`${person.firstName} ${person.lastName}`} />
                  ))}
                </Select>
              )}
            />
            <Controller
              name="status"
              control={form.control}
              render={({ field }) => (
                <Select {...field} id={`${formId}-status`} labelText="Status">
                  {['open', 'in_progress', 'blocked', 'done', 'cancelled'].map((value) => (
                    <SelectItem key={value} value={value} text={value.replace('_', ' ')} />
                  ))}
                </Select>
              )}
            />
            <Controller
              name="priority"
              control={form.control}
              render={({ field }) => (
                <Select {...field} id={`${formId}-priority`} labelText="Priority">
                  {['low', 'normal', 'high', 'urgent'].map((value) => (
                    <SelectItem key={value} value={value} text={value} />
                  ))}
                </Select>
              )}
            />
            <Controller
              name="dueAt"
              control={form.control}
              render={({ field }) => (
                <TextInput {...field} id={`${formId}-due`} type="datetime-local" labelText="Due (optional)" />
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
