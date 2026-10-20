import { InlineNotification, Modal, NumberInput, Stack, TextInput, TimePicker } from '@carbon/react';
import { RoleMultiSelect } from '../RoleMultiSelect';
import { BulkEditState, changedBulkEditField, hasBulkEditChanges } from './scheduleHelpers';
import type { ScheduleEditor } from './useScheduleEditor';

export function BulkEditDialog({ editor, bulkEditing }: { editor: ScheduleEditor; bulkEditing: BulkEditState }) {
  const {
    rolesQuery,
    localDiscard,
    setBulkEditing,
    bulkEditError,
    setBulkEditError,
    unsavedChanges,
    closeBulk,
    applyBulkEdit,
    requestBulkClose,
  } = editor;

  return (
    <Modal
      open={!unsavedChanges.dialogOpen}
      size="sm"
      danger={localDiscard === 'bulk'}
      selectorPrimaryFocus={localDiscard === 'bulk' ? '.cds--btn--secondary' : undefined}
      modalHeading={
        localDiscard === 'bulk'
          ? 'Discard bulk inputs?'
          : `Edit ${bulkEditing.slots.length} selected Open Day${bulkEditing.slots.length === 1 ? '' : 's'}`
      }
      primaryButtonText={localDiscard === 'bulk' ? 'Discard inputs' : 'Apply to selected'}
      primaryButtonDisabled={localDiscard !== 'bulk' && !hasBulkEditChanges(bulkEditing)}
      secondaryButtonText={localDiscard === 'bulk' ? 'Keep editing' : 'Cancel'}
      onRequestClose={requestBulkClose}
      onRequestSubmit={localDiscard === 'bulk' ? closeBulk : applyBulkEdit}
    >
      {localDiscard === 'bulk' ? (
        <p>Your bulk form inputs will be discarded. The schedule working copy will be kept.</p>
      ) : (
        <Stack gap={5}>
          <p>Only values you change are applied.</p>
          {bulkEditError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Selected Open Days were not changed"
              subtitle={bulkEditError}
            />
          )}
          <div className="bulk-slot-editor__times">
            <TimePicker
              id="bulk-start"
              labelText="Start"
              placeholder={bulkEditing.startTime.mixed ? 'Mixed' : 'HH:MM'}
              value={bulkEditing.startTime.mixed ? '' : bulkEditing.startTime.value}
              onChange={(event) => {
                setBulkEditError(null);
                setBulkEditing({ ...bulkEditing, startTime: changedBulkEditField(event.target.value) });
              }}
            />
            <TimePicker
              id="bulk-end"
              labelText="End"
              placeholder={bulkEditing.endTime.mixed ? 'Mixed' : 'HH:MM'}
              value={bulkEditing.endTime.mixed ? '' : bulkEditing.endTime.value}
              onChange={(event) => {
                setBulkEditError(null);
                setBulkEditing({ ...bulkEditing, endTime: changedBulkEditField(event.target.value) });
              }}
            />
          </div>
          <div className="bulk-slot-editor__requirements">
            <NumberInput
              id="bulk-supervisors"
              label="Supervisors required"
              min={0}
              max={100}
              allowEmpty
              placeholder={bulkEditing.supervisors.mixed ? 'Mixed' : undefined}
              value={bulkEditing.supervisors.mixed ? '' : bulkEditing.supervisors.value}
              onChange={(_, value) => {
                setBulkEditError(null);
                setBulkEditing({
                  ...bulkEditing,
                  supervisors: changedBulkEditField(value.value === '' ? '' : Number(value.value)),
                });
              }}
            />
            <NumberInput
              id="bulk-trainees"
              label="Trainees required"
              min={0}
              max={100}
              allowEmpty
              placeholder={bulkEditing.trainees.mixed ? 'Mixed' : undefined}
              value={bulkEditing.trainees.mixed ? '' : bulkEditing.trainees.value}
              onChange={(_, value) => {
                setBulkEditError(null);
                setBulkEditing({
                  ...bulkEditing,
                  trainees: changedBulkEditField(value.value === '' ? '' : Number(value.value)),
                });
              }}
            />
          </div>
          <RoleMultiSelect
            id="bulk-supervisor-roles"
            titleText="Eligible supervisor roles"
            roles={rolesQuery.data?.items ?? []}
            selectedRoleIds={bulkEditing.supervisorRoleIds.mixed ? [] : bulkEditing.supervisorRoleIds.value}
            label={bulkEditing.supervisorRoleIds.mixed ? 'Mixed' : 'Choose roles'}
            onChange={(supervisorRoleIds) => {
              setBulkEditError(null);
              setBulkEditing({ ...bulkEditing, supervisorRoleIds: changedBulkEditField(supervisorRoleIds) });
            }}
          />
          <RoleMultiSelect
            id="bulk-trainee-roles"
            titleText="Eligible trainee roles"
            roles={rolesQuery.data?.items ?? []}
            selectedRoleIds={bulkEditing.traineeRoleIds.mixed ? [] : bulkEditing.traineeRoleIds.value}
            label={bulkEditing.traineeRoleIds.mixed ? 'Mixed' : 'Choose roles'}
            onChange={(traineeRoleIds) => {
              setBulkEditError(null);
              setBulkEditing({ ...bulkEditing, traineeRoleIds: changedBulkEditField(traineeRoleIds) });
            }}
          />
          <TextInput
            id="bulk-note"
            labelText="Internal note"
            placeholder={bulkEditing.internalNote.mixed ? 'Mixed' : undefined}
            value={bulkEditing.internalNote.mixed ? '' : bulkEditing.internalNote.value}
            onChange={(event) => {
              setBulkEditError(null);
              setBulkEditing({ ...bulkEditing, internalNote: changedBulkEditField(event.target.value) });
            }}
          />
        </Stack>
      )}
    </Modal>
  );
}
