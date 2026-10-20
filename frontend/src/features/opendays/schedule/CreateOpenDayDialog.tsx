import {
  Checkbox,
  InlineNotification,
  Modal,
  NumberInput,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TimePicker,
} from '@carbon/react';
import { DateInput } from '../../../app/DateInput';
import { formatDate } from '../../../app/dateTime';
import { RoleMultiSelect } from '../RoleMultiSelect';
import { dateInTimeZone } from '../dateTime';
import { scheduleErrorMessage, createConfigurationError } from './scheduleHelpers';
import type { OpenDaySchedule } from '../../../api/generated/models';
import type { ScheduleEditor } from './useScheduleEditor';

export function CreateOpenDayDialog({ editor, schedule }: { editor: ScheduleEditor; schedule: OpenDaySchedule }) {
  const {
    rolesQuery,
    dispatch,
    setDefaults,
    setCreateOpen,
    createMode,
    setCreateMode,
    setCreateTouched,
    localDiscard,
    seriesStep,
    setSeriesStep,
    createDate,
    setCreateDate,
    createDraft,
    setCreateDraft,
    timeError,
    setTimeError,
    recurrence,
    setRecurrence,
    preview,
    setPreview,
    selectedOccurrences,
    setSelectedOccurrences,
    unsavedChanges,
    closeCreate,
    makeLocalSlot,
    addDate,
    previewMutation,
    requestCreateClose,
  } = editor;

  return (
    <Modal
      open={!unsavedChanges.dialogOpen}
      size="sm"
      danger={localDiscard === 'create'}
      selectorPrimaryFocus={localDiscard === 'create' ? '.cds--btn--secondary' : undefined}
      modalHeading={
        localDiscard === 'create'
          ? 'Discard Open Day inputs?'
          : seriesStep === 'review'
            ? 'Review Open Day series'
            : 'Create Open Day'
      }
      primaryButtonText={
        localDiscard === 'create'
          ? 'Discard inputs'
          : createMode === 'single'
            ? 'Create'
            : seriesStep === 'review'
              ? 'Add selected'
              : previewMutation.isPending
                ? 'Previewing…'
                : 'Preview series'
      }
      primaryButtonDisabled={
        previewMutation.isPending ||
        (localDiscard !== 'create' && seriesStep === 'review' && selectedOccurrences.size === 0)
      }
      secondaryButtonText={
        localDiscard === 'create' ? 'Keep editing' : seriesStep === 'review' ? 'Back to inputs' : 'Cancel'
      }
      onSecondarySubmit={seriesStep === 'review' && !localDiscard ? () => setSeriesStep('inputs') : undefined}
      onRequestClose={requestCreateClose}
      onRequestSubmit={() => {
        if (localDiscard === 'create') {
          closeCreate();
          return;
        }
        if (previewMutation.isPending) return;
        const configurationError = createConfigurationError(createDraft);
        if (configurationError) {
          setTimeError(configurationError);
          return;
        }
        if (createMode === 'single') {
          if (addDate(createDate, createDraft)) {
            setDefaults(createDraft);
            setCreateOpen(false);
            setCreateTouched(false);
          }
          return;
        }
        if (seriesStep === 'inputs') {
          if (preview.length) setSeriesStep('review');
          else previewMutation.mutate();
          return;
        }
        const slots = preview
          .filter((occurrence) => selectedOccurrences.has(occurrence.startsAt))
          .map((occurrence) => makeLocalSlot(occurrence.startsAt, occurrence.endsAt, createDraft));
        dispatch({ type: 'addMany', slots });
        setDefaults(createDraft);
        setCreateOpen(false);
        setCreateTouched(false);
        setPreview([]);
      }}
    >
      {localDiscard === 'create' ? (
        <p>
          Your changes to this form have not been added to the schedule. The existing schedule working copy will be
          kept.
        </p>
      ) : (
        <Stack gap={5} onChangeCapture={() => setCreateTouched(true)}>
          {seriesStep === 'inputs' && (
            <>
              <RadioButtonGroup
                legendText="Creation type"
                name="open-day-create-mode"
                valueSelected={createMode}
                onChange={(value) => {
                  setCreateMode(value as 'single' | 'series');
                  setPreview([]);
                  setTimeError(null);
                }}
              >
                <RadioButton id="create-single-open-day" labelText="Single Open Day" value="single" />
                <RadioButton id="create-open-day-series" labelText="Series" value="series" />
              </RadioButtonGroup>
              {timeError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Open Day was not created"
                  subtitle={timeError}
                />
              )}
              {createMode === 'single' ? (
                <DateInput
                  id="create-open-day-date"
                  labelText="Date"
                  value={createDate}
                  onChange={(date) => {
                    setCreateTouched(true);
                    setCreateDate(date);
                    setTimeError(null);
                  }}
                />
              ) : (
                <Stack gap={4}>
                  <Select
                    id="recurrence-weekday"
                    labelText="Weekday"
                    value={recurrence.weekday}
                    onChange={(event) => {
                      setRecurrence({ ...recurrence, weekday: Number(event.target.value) });
                      setPreview([]);
                    }}
                  >
                    {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map(
                      (name, index) => (
                        <SelectItem key={name} value={index + 1} text={name} />
                      ),
                    )}
                  </Select>
                  <DateInput
                    id="recurrence-start"
                    labelText="From"
                    value={recurrence.startsOn}
                    onChange={(startsOn) => {
                      setCreateTouched(true);
                      setRecurrence({ ...recurrence, startsOn });
                      setPreview([]);
                    }}
                  />
                  <DateInput
                    id="recurrence-end"
                    labelText="Until"
                    value={recurrence.endsOn}
                    onChange={(endsOn) => {
                      setCreateTouched(true);
                      setRecurrence({ ...recurrence, endsOn });
                      setPreview([]);
                    }}
                  />
                  <NumberInput
                    id="recurrence-weeks"
                    label="Every number of weeks"
                    min={1}
                    max={52}
                    value={recurrence.everyWeeks}
                    onChange={(_, value) => {
                      setCreateTouched(true);
                      setRecurrence({ ...recurrence, everyWeeks: Number(value.value) });
                      setPreview([]);
                    }}
                  />
                  <Checkbox
                    id="skip-holidays"
                    labelText="Skip public holidays"
                    checked={recurrence.skipPublicHolidays}
                    onChange={(_, value) => {
                      setRecurrence({ ...recurrence, skipPublicHolidays: value.checked });
                      setPreview([]);
                    }}
                  />
                  <Checkbox
                    id="skip-breaks"
                    labelText="Skip academic breaks"
                    checked={recurrence.skipAcademicBreaks}
                    onChange={(_, value) => {
                      setRecurrence({ ...recurrence, skipAcademicBreaks: value.checked });
                      setPreview([]);
                    }}
                  />
                </Stack>
              )}
              <div className="open-day-create__times">
                <TimePicker
                  id="create-start"
                  labelText="Start"
                  value={createDraft.startTime}
                  onChange={(event) => {
                    setCreateDraft({ ...createDraft, startTime: event.target.value });
                    setPreview([]);
                    setTimeError(null);
                  }}
                />
                <TimePicker
                  id="create-end"
                  labelText="End"
                  value={createDraft.endTime}
                  onChange={(event) => {
                    setCreateDraft({ ...createDraft, endTime: event.target.value });
                    setPreview([]);
                    setTimeError(null);
                  }}
                />
              </div>
              <div className="open-day-create__requirements">
                <NumberInput
                  id="create-supervisors"
                  label="Supervisors"
                  min={0}
                  max={100}
                  value={createDraft.supervisors}
                  onChange={(_, value) => {
                    setCreateTouched(true);
                    setCreateDraft({ ...createDraft, supervisors: Number(value.value) });
                    setPreview([]);
                    setTimeError(null);
                  }}
                />
                <NumberInput
                  id="create-trainees"
                  label="Trainees"
                  min={0}
                  max={100}
                  value={createDraft.trainees}
                  onChange={(_, value) => {
                    setCreateTouched(true);
                    setCreateDraft({ ...createDraft, trainees: Number(value.value) });
                    setPreview([]);
                    setTimeError(null);
                  }}
                />
              </div>
              <RoleMultiSelect
                id="create-supervisor-roles"
                titleText="Eligible supervisor roles"
                roles={rolesQuery.data?.items ?? []}
                selectedRoleIds={createDraft.supervisorRoleIds}
                onChange={(supervisorRoleIds) => {
                  setCreateTouched(true);
                  setCreateDraft({ ...createDraft, supervisorRoleIds });
                  setPreview([]);
                  setTimeError(null);
                }}
              />
              <RoleMultiSelect
                id="create-trainee-roles"
                titleText="Eligible trainee roles"
                roles={rolesQuery.data?.items ?? []}
                selectedRoleIds={createDraft.traineeRoleIds}
                onChange={(traineeRoleIds) => {
                  setCreateTouched(true);
                  setCreateDraft({ ...createDraft, traineeRoleIds });
                  setPreview([]);
                  setTimeError(null);
                }}
              />
            </>
          )}
          {seriesStep === 'review' && (
            <p>
              Step 2 of 2: review the generated dates. Select the dates to add; holidays, academic breaks and other
              exceptions remain marked. {selectedOccurrences.size} selected.
            </p>
          )}
          {createMode === 'series' && previewMutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Preview failed"
              subtitle={scheduleErrorMessage(previewMutation.error)}
            />
          )}
          {seriesStep === 'review' && preview.length === 0 && (
            <p>No dates match this series. Return to the inputs to change the range or weekday.</p>
          )}
          {seriesStep === 'review' &&
            preview.map((item) => (
              <Checkbox
                key={item.startsAt}
                id={`occurrence-${item.startsAt}`}
                labelText={`${formatDate(dateInTimeZone(item.startsAt, schedule.timeZone))} · ${item.disposition}${item.reason ? ` — ${item.reason}` : ''}`}
                checked={selectedOccurrences.has(item.startsAt)}
                onChange={(_, value) =>
                  setSelectedOccurrences((current) => {
                    const next = new Set(current);
                    if (value.checked) next.add(item.startsAt);
                    else next.delete(item.startsAt);
                    return next;
                  })
                }
              />
            ))}
        </Stack>
      )}
    </Modal>
  );
}
