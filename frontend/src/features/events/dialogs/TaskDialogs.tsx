import { Checkbox, InlineNotification, Modal, Select, SelectItem, TextArea, TextInput } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import {
  createEventTask,
  createEventTaskList,
  updateEventTask,
  updateEventTaskList,
} from '../../../api/generated/events/events';
import type { Event, EventTask, EventTaskList } from '../../../api/generated/models';
import { DateInput } from '../../../app/DateInput';
import { dateInAppTimeZone } from '../../../app/dateTime';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { FieldRow, FormSection, FormSections } from '../components/FormSection';
import { PersonCombo, type PersonChoice } from '../components/PersonCombo';
import { eventMutationMessage } from '../errors';
import { toInstant } from '../format';
import { invalidateEvents } from '../queries';
import { taskBody, taskListBody } from '../requestBodies';

type TaskValues = {
  title: string;
  description: string;
  listId: string;
  assignee: PersonChoice | null;
  due: string;
  important: boolean;
};

/** Adds or edits a task. The due date is the end of that day in the lab's time zone. */
export function TaskDialog({
  event,
  task,
  listId,
  lists,
  onClose,
}: {
  event: Event;
  task?: EventTask;
  listId?: string | null;
  lists: EventTaskList[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const form = useForm<TaskValues>({
    defaultValues: {
      title: task?.title ?? '',
      description: task?.description ?? '',
      listId: task?.taskListId ?? listId ?? '',
      assignee: task?.assigneePersonId
        ? { id: task.assigneePersonId, label: task.assigneeName ?? 'Deleted person' }
        : null,
      due: task?.dueAt ? dateInAppTimeZone(task.dueAt) : '',
      important: task?.important ?? false,
    },
  });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const save = useMutation({
    mutationFn: (value: TaskValues) => {
      const input = {
        taskListId: value.listId || null,
        title: value.title.trim(),
        description: value.description.trim() || null,
        assigneePersonId: value.assignee?.id ?? null,
        dueAt: value.due ? toInstant(value.due, '23:59') : null,
        important: value.important,
      };
      return task
        ? updateEventTask(event.id, task.id, taskBody(task, input))
        : createEventTask(event.id, { ...input, status: 'open', sortOrder: 0 });
    },
    onSuccess: async () => {
      await invalidateEvents(client);
      guard.bypassAfterSubmit(onClose);
    },
  });
  const requestClose = useLatestCallback(() => {
    if (!save.isPending) guard.requestDiscard(onClose);
  });
  const submit = form.handleSubmit((value) => {
    if (!save.isPending) save.mutate(value);
  });
  return (
    <>
      <Modal
        open={!guard.dialogOpen}
        size="md"
        modalHeading={task ? 'Edit task' : 'Add task'}
        modalLabel={event.name}
        primaryButtonText={save.isPending ? 'Saving…' : task ? 'Save task' : 'Add task'}
        secondaryButtonText="Cancel"
        primaryButtonDisabled={save.isPending}
        preventCloseOnClickOutside
        onRequestClose={requestClose}
        onRequestSubmit={() => void submit()}
      >
        <FormSections>
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Task not saved"
              subtitle={eventMutationMessage(save.error)}
            />
          )}
          <FormSection title="Task">
            <TextInput
              id="ev-task-title"
              labelText="Title"
              invalid={Boolean(form.formState.errors.title)}
              invalidText="Enter a title."
              {...form.register('title', { validate: (value) => value.trim().length > 0 && value.length <= 200 })}
            />
            <TextArea
              id="ev-task-description"
              labelText="Description (optional)"
              rows={2}
              maxLength={10000}
              {...form.register('description')}
            />
            <Select id="ev-task-list" labelText="List" {...form.register('listId')}>
              <SelectItem value="" text="No list" />
              {lists.map((list) => (
                <SelectItem key={list.id} value={list.id} text={list.name} />
              ))}
            </Select>
          </FormSection>
          <FormSection title="Assignment">
            <FieldRow>
              <Controller
                name="assignee"
                control={form.control}
                render={({ field }) => (
                  <PersonCombo
                    id="ev-task-assignee"
                    titleText="Assignee"
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
              <Controller
                name="due"
                control={form.control}
                render={({ field }) => (
                  <DateInput
                    id="ev-task-due"
                    labelText="Due date (optional)"
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />
            </FieldRow>
            <Controller
              name="important"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  id="ev-task-important"
                  labelText="Important"
                  helperText="Important tasks are highlighted in the task list."
                  checked={field.value}
                  onChange={(_, { checked }) => field.onChange(checked)}
                />
              )}
            />
          </FormSection>
        </FormSections>
      </Modal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}

/** Adds a task list or renames one. */
export function TaskListDialog({ event, list, onClose }: { event: Event; list?: EventTaskList; onClose: () => void }) {
  const client = useQueryClient();
  const form = useForm<{ name: string }>({ defaultValues: { name: list?.name ?? '' } });
  const save = useMutation({
    mutationFn: ({ name }: { name: string }) =>
      list
        ? updateEventTaskList(event.id, list.id, taskListBody(list, { name: name.trim() }))
        : createEventTaskList(event.id, { name: name.trim(), description: null, sortOrder: 0 }),
    onSuccess: async () => {
      await invalidateEvents(client);
      onClose();
    },
  });
  const submit = form.handleSubmit((value) => {
    if (!save.isPending) save.mutate(value);
  });
  return (
    <Modal
      open
      size="xs"
      modalHeading={list ? 'Rename list' : 'Add list'}
      modalLabel={event.name}
      primaryButtonText={save.isPending ? 'Saving…' : list ? 'Rename' : 'Add list'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={save.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!save.isPending) onClose();
      }}
      onRequestSubmit={() => void submit()}
    >
      {save.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="List not saved"
          subtitle={eventMutationMessage(save.error)}
        />
      )}
      <TextInput
        id="ev-list-name"
        labelText="Name"
        invalid={Boolean(form.formState.errors.name)}
        invalidText="Enter a name."
        {...form.register('name', { validate: (value) => value.trim().length > 0 && value.length <= 200 })}
      />
    </Modal>
  );
}
