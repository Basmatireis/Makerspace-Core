import type { ReactNode } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import {
  Button,
  Checkbox,
  FormGroup,
  IconButton,
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { Add, ArrowDown, ArrowUp, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { WorkingGroup, WorkingGroupSummary, WorkingGroupTicketKind } from '../../api/generated/models';
import {
  closeWorkingGroupTicket,
  createWorkingGroupTicket,
  createWorkingGroupTodo,
  planWorkingGroupTicket,
  setWorkingGroupColumns,
} from '../../api/generated/working-groups/working-groups';
import { apiErrorCode } from '../../api/http-client';
import { DateInput } from '../../app/DateInput';
import { useNotify } from '../../app/toasts';
import { workingGroupOptions } from './queries';
import { REPEAT_CHOICES, addDays, firstName, todayOn, type Task } from './taskModel';
import { useWgMutation } from './useWgMutation';

function DialogShell({
  heading,
  primary,
  pending,
  failed,
  failedTitle,
  onClose,
  onSubmit,
  children,
}: {
  heading: string;
  primary: string;
  pending: boolean;
  failed?: string;
  failedTitle?: string;
  onClose: () => void;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <Modal
      open
      size="sm"
      modalHeading={heading}
      primaryButtonText={pending ? 'Saving…' : primary}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={onSubmit}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Stack gap={6}>
          {failed && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title={failedTitle ?? 'Not saved'}
              subtitle={failed}
            />
          )}
          {children}
        </Stack>
      </form>
    </Modal>
  );
}

const CHECK_FIELDS = 'Check the fields and your connection, then try again.';

// ---------------------------------------------------------------------------------------------------------------
// Write a ticket
// ---------------------------------------------------------------------------------------------------------------

interface TicketValues {
  groupId: string;
  machineId: string;
  kind: WorkingGroupTicketKind;
  subject: string;
  body: string;
  blocksUse: boolean;
}

export function WriteTicketDialog({
  groups,
  initialGroupId,
  onClose,
}: {
  groups: readonly WorkingGroupSummary[];
  initialGroupId: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const { control, handleSubmit, register, setValue, watch } = useForm<TicketValues>({
    defaultValues: {
      groupId: initialGroupId || groups[0]?.id || '',
      machineId: '',
      kind: 'problem',
      subject: '',
      body: '',
      blocksUse: false,
    },
  });
  const groupId = watch('groupId');
  const detail = useQuery({ ...workingGroupOptions(groupId), enabled: groupId !== '' });
  const create = useWgMutation((values: TicketValues) =>
    createWorkingGroupTicket({
      groupId: values.groupId,
      machineId: values.machineId || undefined,
      kind: values.kind,
      subject: values.subject.trim(),
      body: values.body.trim() || undefined,
      blocksUse: values.blocksUse,
    }),
  );
  const submit = handleSubmit((values) =>
    create.mutate(values, {
      onSuccess: () => {
        notify({ kind: 'success', title: 'Ticket sent' });
        onClose();
      },
    }),
  );
  return (
    <DialogShell
      heading="Write a ticket"
      primary="Send"
      pending={create.isPending}
      failed={create.isError ? CHECK_FIELDS : undefined}
      failedTitle="Ticket not sent"
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <FormGroup legendText="About">
        <Stack gap={5}>
          <Select
            id="wg-ticket-group"
            labelText="Working group"
            {...register('groupId', {
              onChange: () => setValue('machineId', ''),
            })}
          >
            {groups.map((group) => (
              <SelectItem key={group.id} value={group.id} text={group.name} />
            ))}
          </Select>
          <Select id="wg-ticket-machine" labelText="Machine or place" {...register('machineId')}>
            <SelectItem value="" text="In general" />
            {(detail.data?.machines ?? []).map((machine) => (
              <SelectItem key={machine.id} value={machine.id} text={machine.name} />
            ))}
          </Select>
        </Stack>
      </FormGroup>
      <Controller
        control={control}
        name="kind"
        render={({ field }) => (
          <RadioButtonGroup
            legendText="What is it?"
            name="wg-ticket-kind"
            valueSelected={field.value}
            onChange={(value) => field.onChange(value)}
          >
            <RadioButton id="wg-kind-problem" labelText="Problem" value="problem" />
            <RadioButton id="wg-kind-request" labelText="Request" value="request" />
            <RadioButton id="wg-kind-question" labelText="Question" value="question" />
          </RadioButtonGroup>
        )}
      />
      <Controller
        control={control}
        name="subject"
        rules={{
          validate: (value) => (value.trim() !== '' && value.trim().length <= 120) || 'Enter up to 120 characters.',
        }}
        render={({ field, fieldState }) => (
          <TextInput
            id="wg-ticket-subject"
            labelText="In one sentence"
            invalid={Boolean(fieldState.error)}
            invalidText={fieldState.error?.message}
            {...field}
          />
        )}
      />
      <Controller
        control={control}
        name="body"
        rules={{ maxLength: { value: 2000, message: 'Enter up to 2000 characters.' } }}
        render={({ field, fieldState }) => (
          <TextArea
            id="wg-ticket-body"
            labelText="Details"
            rows={3}
            invalid={Boolean(fieldState.error)}
            invalidText={fieldState.error?.message}
            {...field}
          />
        )}
      />
      <Controller
        control={control}
        name="blocksUse"
        render={({ field }) => (
          <Checkbox
            id="wg-ticket-blocks"
            labelText="It cannot be used right now"
            checked={field.value}
            onChange={(_, { checked }) => field.onChange(checked)}
          />
        )}
      />
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// New to-do
// ---------------------------------------------------------------------------------------------------------------

interface TodoValues {
  groupId: string;
  title: string;
  assigneePersonId: string;
  dueOn: string;
  repeat: string;
}

export function NewTodoDialog({
  groups,
  initialGroupId,
  onClose,
}: {
  groups: readonly WorkingGroupSummary[];
  initialGroupId: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const { control, handleSubmit, register, setValue, watch } = useForm<TodoValues>({
    defaultValues: {
      groupId: initialGroupId || groups[0]?.id || '',
      title: '',
      assigneePersonId: '',
      dueOn: addDays(todayOn(), 7),
      repeat: '',
    },
  });
  const groupId = watch('groupId');
  const detail = useQuery({ ...workingGroupOptions(groupId), enabled: groupId !== '' });
  const create = useWgMutation((values: TodoValues) =>
    createWorkingGroupTodo({
      groupId: values.groupId,
      title: values.title.trim(),
      assigneePersonId: values.assigneePersonId || undefined,
      dueOn: values.dueOn,
      repeatEveryDays: values.repeat ? Number(values.repeat) : undefined,
    }),
  );
  const submit = handleSubmit((values) =>
    create.mutate(values, {
      onSuccess: () => {
        notify({ kind: 'success', title: 'To-do added' });
        onClose();
      },
    }),
  );
  return (
    <DialogShell
      heading="New to-do"
      primary="Add"
      pending={create.isPending}
      failed={create.isError ? CHECK_FIELDS : undefined}
      failedTitle="To-do not added"
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      {groups.length > 1 && (
        <Select
          id="wg-todo-group"
          labelText="Working group"
          {...register('groupId', { onChange: () => setValue('assigneePersonId', '') })}
        >
          {groups.map((group) => (
            <SelectItem key={group.id} value={group.id} text={group.name} />
          ))}
        </Select>
      )}
      <Controller
        control={control}
        name="title"
        rules={{
          validate: (value) => (value.trim() !== '' && value.trim().length <= 160) || 'Enter up to 160 characters.',
        }}
        render={({ field, fieldState }) => (
          <TextInput
            id="wg-todo-title"
            labelText="What needs doing"
            invalid={Boolean(fieldState.error)}
            invalidText={fieldState.error?.message}
            {...field}
          />
        )}
      />
      <Select id="wg-todo-who" labelText="Who" {...register('assigneePersonId')}>
        <SelectItem value="" text="Unassigned" />
        {(detail.data?.members ?? []).map((member) => (
          <SelectItem key={member.personId} value={member.personId} text={member.displayName} />
        ))}
      </Select>
      <Controller
        control={control}
        name="dueOn"
        rules={{ validate: (value) => value !== '' || 'Choose a date.' }}
        render={({ field, fieldState }) => (
          <DateInput
            id="wg-todo-due"
            labelText="Due"
            value={field.value}
            onChange={field.onChange}
            invalid={Boolean(fieldState.error)}
            invalidText={fieldState.error?.message}
          />
        )}
      />
      <Select id="wg-todo-repeat" labelText="Repeats" {...register('repeat')}>
        <SelectItem value="" text="Does not repeat" />
        {REPEAT_CHOICES.map((choice) => (
          <SelectItem key={choice.days} value={String(choice.days)} text={choice.label} />
        ))}
      </Select>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Plan it
// ---------------------------------------------------------------------------------------------------------------

interface PlanValues {
  assigneePersonId: string;
  dueOn: string;
  columnId: string;
}

export function PlanDialog({
  task,
  columnId,
  me,
  onClose,
}: {
  task: Task;
  columnId?: string;
  me: string;
  onClose: () => void;
}) {
  const detail = useQuery(workingGroupOptions(task.groupId));
  if (!detail.data) return null;
  return <PlanForm task={task} group={detail.data} columnId={columnId} me={me} onClose={onClose} />;
}

function PlanForm({
  task,
  group,
  columnId,
  me,
  onClose,
}: {
  task: Task;
  group: WorkingGroup;
  columnId?: string;
  me: string;
  onClose: () => void;
}) {
  const notify = useNotify();
  const member = group.members.some((candidate) => candidate.personId === me);
  const { control, handleSubmit, register } = useForm<PlanValues>({
    defaultValues: {
      assigneePersonId: member ? me : (group.lead?.personId ?? ''),
      dueOn: addDays(todayOn(), 7),
      columnId: columnId ?? group.columns[0]?.id ?? '',
    },
  });
  const plan = useWgMutation((values: PlanValues) =>
    planWorkingGroupTicket(task.id, {
      columnId: values.columnId,
      assigneePersonId: values.assigneePersonId || undefined,
      dueOn: values.dueOn || undefined,
    }),
  );
  const submit = handleSubmit((values) =>
    plan.mutate(values, {
      onSuccess: () => {
        notify({ kind: 'success', title: 'Ticket planned', subtitle: task.title });
        onClose();
      },
    }),
  );
  return (
    <DialogShell
      heading="Plan it"
      primary="Plan it"
      pending={plan.isPending}
      failed={plan.isError ? 'It could not be planned. Reload the page and try again.' : undefined}
      failedTitle="Not planned"
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <Select id="wg-plan-who" labelText="Who" {...register('assigneePersonId')}>
        <SelectItem value="" text="Unassigned" />
        {group.members.map((candidate) => (
          <SelectItem key={candidate.personId} value={candidate.personId} text={candidate.displayName} />
        ))}
      </Select>
      <Controller
        control={control}
        name="dueOn"
        render={({ field }) => (
          <DateInput id="wg-plan-due" labelText="Due" value={field.value} onChange={field.onChange} />
        )}
      />
      <Select id="wg-plan-column" labelText="Column" {...register('columnId')}>
        {group.columns.map((column) => (
          <SelectItem key={column.id} value={column.id} text={column.name} />
        ))}
      </Select>
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Answer and close
// ---------------------------------------------------------------------------------------------------------------

type Ending = 'answered' | 'done' | 'declined';
interface CloseValues {
  ending: Ending;
  answer: string;
}

export function CloseTicketDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const notify = useNotify();
  const { control, handleSubmit, watch } = useForm<CloseValues>({ defaultValues: { ending: 'answered', answer: '' } });
  const declined = watch('ending') === 'declined';
  const close = useWgMutation((values: CloseValues) =>
    closeWorkingGroupTicket(task.id, {
      outcome: values.ending === 'declined' ? 'declined' : 'done',
      answer: values.answer.trim() || undefined,
    }),
  );
  const submit = handleSubmit((values) =>
    close.mutate(values, {
      onSuccess: () => {
        notify({ kind: 'success', title: 'Ticket closed', subtitle: task.title });
        onClose();
      },
    }),
  );
  return (
    <DialogShell
      heading="Answer and close"
      primary="Close the ticket"
      pending={close.isPending}
      failed={close.isError ? 'It could not be closed. Reload the page and try again.' : undefined}
      failedTitle="Not closed"
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <Controller
        control={control}
        name="ending"
        render={({ field }) => (
          <RadioButtonGroup
            legendText="How does it end?"
            name="wg-close-ending"
            valueSelected={field.value}
            onChange={(value) => field.onChange(value)}
          >
            <RadioButton id="wg-end-answered" labelText="Answered" value="answered" />
            <RadioButton id="wg-end-done" labelText="Already done" value="done" />
            <RadioButton id="wg-end-declined" labelText="Declined" value="declined" />
          </RadioButtonGroup>
        )}
      />
      <Controller
        control={control}
        name="answer"
        rules={{
          validate: (value) =>
            (!declined || value.trim() !== '') && value.trim().length <= 2000
              ? true
              : declined && value.trim() === ''
                ? 'Write an answer when you decline.'
                : 'Enter up to 2000 characters.',
        }}
        render={({ field, fieldState }) => (
          <TextArea
            id="wg-close-answer"
            labelText={`Answer for ${firstName(task.author)}`}
            helperText="Posted as a comment."
            rows={3}
            invalid={Boolean(fieldState.error)}
            invalidText={fieldState.error?.message}
            {...field}
          />
        )}
      />
    </DialogShell>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Edit columns
// ---------------------------------------------------------------------------------------------------------------

interface ColumnValues {
  columns: { colId?: string; name: string }[];
}

export function EditColumnsDialog({ groupId, onClose }: { groupId: string; onClose: () => void }) {
  const detail = useQuery(workingGroupOptions(groupId));
  if (!detail.data) return null;
  return <ColumnsForm group={detail.data} onClose={onClose} />;
}

function ColumnsForm({ group, onClose }: { group: WorkingGroup; onClose: () => void }) {
  const notify = useNotify();
  const { control, handleSubmit } = useForm<ColumnValues>({
    defaultValues: { columns: group.columns.map((column) => ({ colId: column.id, name: column.name })) },
  });
  const { fields, append, remove, move } = useFieldArray({ control, name: 'columns' });
  const save = useWgMutation((values: ColumnValues) =>
    setWorkingGroupColumns(group.id, {
      columns: values.columns.map((column) => ({ id: column.colId, name: column.name.trim() })),
    }),
  );
  const submit = handleSubmit((values) =>
    save.mutate(values, {
      onSuccess: () => {
        notify({ kind: 'success', title: 'Columns saved' });
        onClose();
      },
    }),
  );
  const nameTaken = apiErrorCode(save.error) === 'working_group_column_exists';
  return (
    <DialogShell
      heading="Edit columns"
      primary="Save"
      pending={save.isPending}
      failed={save.isError ? (nameTaken ? 'Two columns have the same name.' : CHECK_FIELDS) : undefined}
      failedTitle="Columns not saved"
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <p className="wg-muted">Inbox and Done are fixed.</p>
      <ol className="wg-colform">
        {fields.map((field, index) => (
          <li key={field.id} className="wg-colform__row">
            <Controller
              control={control}
              name={`columns.${index}.name`}
              rules={{
                validate: (value) => (value.trim() !== '' && value.trim().length <= 40) || 'Enter up to 40 characters.',
              }}
              render={({ field: input, fieldState }) => (
                <TextInput
                  id={`wg-colname-${field.id}`}
                  labelText={`Column ${index + 1}`}
                  hideLabel
                  invalid={Boolean(fieldState.error)}
                  invalidText={fieldState.error?.message}
                  {...input}
                />
              )}
            />
            <IconButton
              kind="ghost"
              size="md"
              label="Move up"
              disabled={index === 0}
              onClick={() => move(index, index - 1)}
            >
              <ArrowUp />
            </IconButton>
            <IconButton
              kind="ghost"
              size="md"
              label="Move down"
              disabled={index === fields.length - 1}
              onClick={() => move(index, index + 1)}
            >
              <ArrowDown />
            </IconButton>
            <IconButton
              kind="ghost"
              size="md"
              label="Remove column"
              disabled={fields.length <= 1}
              onClick={() => remove(index)}
            >
              <TrashCan />
            </IconButton>
          </li>
        ))}
      </ol>
      <div>
        <Button
          kind="tertiary"
          size="md"
          renderIcon={Add}
          disabled={fields.length >= 20}
          onClick={() => append({ name: '' })}
        >
          Add a column
        </Button>
      </div>
    </DialogShell>
  );
}
