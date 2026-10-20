import { InlineNotification, Modal } from '@carbon/react';
import { type WorkingSlot } from '../scheduleState';
import { removalButtonLabel, removalHeading, removalConfirmation } from './scheduleHelpers';
import { SlotForm } from './SlotForm';
import type { OpenDaySchedule } from '../../../api/generated/models';
import type { ScheduleEditor } from './useScheduleEditor';

export function LifecycleTransitionDialog({ editor }: { editor: ScheduleEditor }) {
  const { pendingTransition, unsavedChanges, lifecycleMutation, requestLifecycleClose } = editor;

  return (
    <Modal
      open={Boolean(pendingTransition) && !unsavedChanges.dialogOpen}
      danger={pendingTransition?.danger}
      modalHeading={pendingTransition?.label ?? 'Change period status'}
      primaryButtonText={pendingTransition?.label ?? 'Continue'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={lifecycleMutation.isPending}
      onRequestClose={requestLifecycleClose}
      onRequestSubmit={() => {
        if (!pendingTransition) return;
        if (!lifecycleMutation.isPending) lifecycleMutation.mutate(pendingTransition.target);
      }}
    >
      {lifecycleMutation.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Status change failed"
          subtitle="The period may have changed. Your schedule is kept; try again."
        />
      )}
      <p>{pendingTransition?.confirmation}</p>
    </Modal>
  );
}

export function EditOpenDayDialog({ editor, schedule }: { editor: ScheduleEditor; schedule: OpenDaySchedule }) {
  const {
    rolesQuery,
    dispatch,
    localDiscard,
    timeError,
    setTimeError,
    editing,
    setEditing,
    setPendingRemoval,
    unsavedChanges,
    closeEditing,
    requestEditClose,
  } = editor;

  return (
    <Modal
      open={Boolean(editing) && !unsavedChanges.dialogOpen}
      danger={localDiscard === 'edit'}
      selectorPrimaryFocus={localDiscard === 'edit' ? '.cds--btn--secondary' : undefined}
      modalHeading={localDiscard === 'edit' ? 'Discard Open Day inputs?' : 'Edit Open Day'}
      primaryButtonText={localDiscard === 'edit' ? 'Discard inputs' : 'Apply'}
      primaryButtonDisabled={localDiscard !== 'edit' && Boolean(timeError)}
      secondaryButtonText={localDiscard === 'edit' ? 'Keep editing' : 'Cancel'}
      onRequestClose={requestEditClose}
      onRequestSubmit={() => {
        if (localDiscard === 'edit') {
          closeEditing();
          return;
        }
        if (!editing) return;
        dispatch({ type: 'update', slot: editing });
        setEditing(null);
      }}
    >
      {localDiscard === 'edit' ? (
        <p>The form inputs will be discarded. Your existing schedule working copy will be kept.</p>
      ) : (
        editing && (
          <SlotForm
            error={timeError}
            onError={setTimeError}
            slot={editing}
            roles={rolesQuery.data?.items ?? []}
            timeZone={schedule.timeZone}
            removalLabel={removalButtonLabel([editing], schedule.period.status)}
            onChange={setEditing}
            onRemove={() => {
              setPendingRemoval([editing]);
              setEditing(null);
            }}
          />
        )
      )}
    </Modal>
  );
}

export function RemovalDialog({
  editor,
  schedule,
  pendingRemoval,
}: {
  editor: ScheduleEditor;
  schedule: OpenDaySchedule;
  pendingRemoval: WorkingSlot[];
}) {
  const { setPendingRemoval, unsavedChanges, confirmRemoval } = editor;

  return (
    <Modal
      open={!unsavedChanges.dialogOpen}
      selectorPrimaryFocus=".cds--btn--secondary"
      danger
      modalHeading={removalHeading(pendingRemoval, schedule.period.status)}
      primaryButtonText={removalButtonLabel(pendingRemoval, schedule.period.status)}
      secondaryButtonText={`Keep Open Day${pendingRemoval.length === 1 ? '' : 's'}`}
      onRequestClose={() => setPendingRemoval(null)}
      onRequestSubmit={confirmRemoval}
    >
      <p>{removalConfirmation(pendingRemoval, schedule.period.status)}</p>
    </Modal>
  );
}

export function PublishedSaveDialog({ editor }: { editor: ScheduleEditor }) {
  const { publishedSaveConfirmation, unsavedChanges, saveMutation, requestPublishedSaveClose } = editor;

  return (
    <Modal
      open={publishedSaveConfirmation && !unsavedChanges.dialogOpen}
      selectorPrimaryFocus=".cds--btn--secondary"
      danger
      modalHeading="Save changes to published schedule?"
      primaryButtonText="Save published schedule"
      secondaryButtonText="Keep editing"
      primaryButtonDisabled={saveMutation.isPending}
      onRequestClose={requestPublishedSaveClose}
      onRequestSubmit={() => saveMutation.mutate()}
    >
      <p>These changes update the public calendar and calendar feed. Subscribers may receive an update.</p>
    </Modal>
  );
}

export function MoveContextDialog({
  editor,
  moveSlot,
}: {
  editor: ScheduleEditor;
  moveSlot: (id: string, date: string) => void;
}) {
  const { pendingMove, setPendingMove, unsavedChanges } = editor;

  return (
    <Modal
      open={Boolean(pendingMove) && !unsavedChanges.dialogOpen}
      modalHeading="Move onto calendar context?"
      primaryButtonText="Move Open Day"
      secondaryButtonText="Keep current date"
      onRequestClose={() => setPendingMove(null)}
      onRequestSubmit={() => {
        if (pendingMove) moveSlot(pendingMove.id, pendingMove.date);
        setPendingMove(null);
      }}
    >
      <p>
        {pendingMove
          ? `${pendingMove.date} is marked as ${pendingMove.entries.map((entry) => entry.name).join(', ')}. This does not prevent scheduling.`
          : ''}
      </p>
    </Modal>
  );
}
