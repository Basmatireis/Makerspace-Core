import type { ReactNode } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  InlineNotification,
  Modal,
  RadioButton,
  RadioButtonGroup,
  Stack,
  Tag,
  TextArea,
  TextInput,
} from '@carbon/react';
import type { WorkingGroupStatus } from '../../api/generated/models';
import {
  createWorkingGroupNote,
  setWorkingGroupMachineStatus,
  setWorkingGroupPlaceStatus,
} from '../../api/generated/working-groups/working-groups';
import { DateInput } from '../../app/DateInput';
import { useNotify } from '../../app/toasts';
import { STATUS_CHOICES, STATUS_LABEL, STATUS_TAG, type StatusTarget } from './statusModel';
import { saveErrorText, useWgMutation } from './useWgMutation';

export function StatusTag({ status }: { status: WorkingGroupStatus | undefined }) {
  const value = status ?? 'ok';
  return (
    <Tag size="sm" type={STATUS_TAG[value]}>
      {STATUS_LABEL[value]}
    </Tag>
  );
}

function FormModal({
  heading,
  primary,
  pending,
  error,
  onClose,
  onSubmit,
  children,
}: {
  heading: string;
  primary: string;
  pending: boolean;
  error: string | null;
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
          {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}
          {children}
        </Stack>
      </form>
    </Modal>
  );
}

interface NoteValues {
  text: string;
  audience: 'group' | 'public';
}

/** Pins a note to a group's board (for the group or for everyone); without a group it is a makerspace note for everyone. */
export function PinNoteDialog({ groupId, onClose }: { groupId?: string; onClose: () => void }) {
  const notify = useNotify();
  const { control, handleSubmit } = useForm<NoteValues>({ defaultValues: { text: '', audience: 'group' } });
  const create = useWgMutation((values: NoteValues) =>
    createWorkingGroupNote({
      groupId,
      public: !groupId || values.audience === 'public',
      text: values.text.trim(),
    }),
  );
  const submit = handleSubmit((values) =>
    create.mutate(values, {
      onSuccess: () => {
        notify({ kind: 'success', title: 'Note pinned' });
        onClose();
      },
    }),
  );
  return (
    <FormModal
      heading="Pin a note"
      primary="Pin"
      pending={create.isPending}
      error={saveErrorText(create.error)}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <Controller
        control={control}
        name="text"
        rules={{
          validate: (value) => (value.trim() !== '' && value.trim().length <= 500) || 'Enter up to 500 characters.',
        }}
        render={({ field, fieldState }) => (
          <TextArea
            id="wg-note-text"
            labelText="Note"
            rows={4}
            enableCounter
            maxCount={500}
            invalid={Boolean(fieldState.error)}
            invalidText={fieldState.error?.message}
            {...field}
          />
        )}
      />
      {groupId && (
        <Controller
          control={control}
          name="audience"
          render={({ field }) => (
            <RadioButtonGroup
              legendText="Who sees it"
              name="wg-note-audience"
              orientation="vertical"
              valueSelected={field.value}
              onChange={(value) => field.onChange(value)}
            >
              <RadioButton id="wg-note-group" labelText="The group" value="group" />
              <RadioButton id="wg-note-public" labelText="Everyone" value="public" />
            </RadioButtonGroup>
          )}
        />
      )}
    </FormModal>
  );
}

interface StatusValues {
  status: WorkingGroupStatus;
  note: string;
  until: string;
}

/** Sets the status of a machine or place; "Working" clears the note and the date. */
export function ChangeStatusDialog({ target, onClose }: { target: StatusTarget; onClose: () => void }) {
  const notify = useNotify();
  const { control, handleSubmit, watch } = useForm<StatusValues>({
    defaultValues: { status: target.status, note: target.note ?? '', until: target.until?.slice(0, 10) ?? '' },
  });
  const status = watch('status');
  const save = useWgMutation((values: StatusValues) => {
    const body =
      values.status === 'ok'
        ? { status: values.status }
        : { status: values.status, note: values.note.trim() || undefined, until: values.until || undefined };
    return target.kind === 'machine'
      ? setWorkingGroupMachineStatus(target.groupId, target.id, body)
      : setWorkingGroupPlaceStatus(target.groupId, target.id, body);
  });
  const submit = handleSubmit((values) =>
    save.mutate(values, {
      onSuccess: () => {
        notify({ kind: 'success', title: 'Status saved' });
        onClose();
      },
    }),
  );
  return (
    <FormModal
      heading={`Change status of ${target.name}`}
      primary="Save"
      pending={save.isPending}
      error={saveErrorText(save.error)}
      onClose={onClose}
      onSubmit={() => void submit()}
    >
      <Controller
        control={control}
        name="status"
        render={({ field }) => (
          <RadioButtonGroup
            legendText="Status"
            name="wg-status"
            orientation="vertical"
            valueSelected={field.value}
            onChange={(value) => field.onChange(value)}
          >
            {STATUS_CHOICES.map((choice) => (
              <RadioButton key={choice} id={`wg-status-${choice}`} labelText={STATUS_LABEL[choice]} value={choice} />
            ))}
          </RadioButtonGroup>
        )}
      />
      {status !== 'ok' && (
        <>
          <Controller
            control={control}
            name="note"
            rules={{ validate: (value) => value.trim().length <= 200 || 'Enter up to 200 characters.' }}
            render={({ field, fieldState }) => (
              <TextInput
                id="wg-status-note"
                labelText="Note"
                maxLength={200}
                invalid={Boolean(fieldState.error)}
                invalidText={fieldState.error?.message}
                {...field}
              />
            )}
          />
          <Controller
            control={control}
            name="until"
            render={({ field }) => (
              <DateInput id="wg-status-until" labelText="Back around" value={field.value} onChange={field.onChange} />
            )}
          />
        </>
      )}
    </FormModal>
  );
}
