import { useState, type ReactNode } from 'react';
import { Button, Checkbox, DismissibleTag, InlineNotification, TextInput } from '@carbon/react';
import { useForm, Controller } from 'react-hook-form';
import type { EligibilityRole, OpenDay } from '../../../api/generated/models';
import { NumberField } from '../components/FormFields';
import { RoleMultiSelect } from '../RoleMultiSelect';
import { clockOf, dateOf, plural, shortDate } from '../model/dates';
import type { BulkPatch } from '../model/bulk';
import { FormPanel } from './FormPanel';

type ToggleFlag = 'changeSupervisorPlaces' | 'changeTraineePlaces' | 'changeSupervisorRoles' | 'changeTraineeRoles';

type Fields = {
  start: string;
  end: string;
  changeSupervisorPlaces: boolean;
  supervisorPlaces: number;
  changeTraineePlaces: boolean;
  traineePlaces: number;
  changeSupervisorRoles: boolean;
  supervisorRoleIds: string[];
  changeTraineeRoles: boolean;
  traineeRoleIds: string[];
};

const defaults: Fields = {
  start: '',
  end: '',
  changeSupervisorPlaces: false,
  supervisorPlaces: 2,
  changeTraineePlaces: false,
  traineePlaces: 1,
  changeSupervisorRoles: false,
  supervisorRoleIds: [],
  changeTraineeRoles: false,
  traineeRoleIds: [],
};

/** Edit several selected open days at once; only the fields you change are applied. */
export function BulkPanel({
  selected,
  roles,
  draftPeriod,
  onUnselect,
  onSelectAll,
  onClear,
  onApply,
  onRemove,
  onClose,
  notifies,
}: {
  selected: OpenDay[];
  roles: readonly EligibilityRole[];
  draftPeriod: boolean;
  onUnselect: (id: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onApply: (patch: BulkPatch) => void;
  onRemove: () => void;
  onClose: () => void;
  notifies: boolean;
}) {
  const form = useForm<Fields>({ defaultValues: defaults });
  const [applied, setApplied] = useState('');
  const inSeries = selected.filter((day) => day.seriesId).length;
  const multi = selected.filter((day) => day.timeslots.length > 1).length;
  const signed = selected.reduce(
    (sum, day) =>
      sum + day.timeslots.reduce((n, slot) => n + slot.requirements.reduce((m, item) => m + item.assignedCount, 0), 0),
    0,
  );
  const submit = form.handleSubmit((v) => {
    const patch: BulkPatch = {
      ...(v.start ? { start: v.start } : {}),
      ...(v.end ? { end: v.end } : {}),
      ...(v.changeSupervisorPlaces ? { supervisorPlaces: v.supervisorPlaces } : {}),
      ...(v.changeTraineePlaces ? { traineePlaces: v.traineePlaces } : {}),
      ...(v.changeSupervisorRoles ? { supervisorRoleIds: v.supervisorRoleIds } : {}),
      ...(v.changeTraineeRoles ? { traineeRoleIds: v.traineeRoleIds } : {}),
    };
    if (!Object.keys(patch).length) {
      setApplied('Change at least one field.');
      return;
    }
    setApplied('');
    onApply(patch);
    form.reset(defaults);
  });
  const toggled = (flag: ToggleFlag, label: string, control: ReactNode) => (
    <div className="od-bulk__field">
      <Controller
        control={form.control}
        name={flag}
        render={({ field }) => (
          <Checkbox
            id={`od-bulk-${flag}`}
            labelText={`Change ${label}`}
            checked={Boolean(field.value)}
            onChange={(_e, { checked }) => field.onChange(checked)}
          />
        )}
      />
      {form.watch(flag) ? control : null}
    </div>
  );
  return (
    <FormPanel
      title={selected.length ? `${plural(selected.length, 'open day')} selected` : 'Select open days'}
      meta="Several open days"
      formId="od-bulk-form"
      primaryLabel={`Apply to ${plural(selected.length, 'open day')}`}
      cancelLabel="Done"
      onCancel={onClose}
      disabled={!selected.length}
    >
      {!selected.length ? (
        <>
          <p className="od-hint">
            Click open days in the list or the calendar to select them, then change them together here.
          </p>
          <div>
            <Button kind="ghost" size="sm" onClick={onSelectAll}>
              Select all shown
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="od-chips">
            {selected.slice(0, 12).map((day) => (
              <DismissibleTag
                key={day.id}
                type="gray"
                size="sm"
                text={`${shortDate(dateOf(day.startsAt))} ${clockOf(day.startsAt)}`}
                title={`Unselect ${shortDate(dateOf(day.startsAt))}`}
                onClose={() => onUnselect(day.id)}
              />
            ))}
            {selected.length > 12 && <span className="od-hint">+{selected.length - 12} more</span>}
          </div>
          <div className="od-inline-actions">
            <Button kind="ghost" size="sm" onClick={onSelectAll}>
              Select all shown
            </Button>
            <Button kind="ghost" size="sm" onClick={onClear}>
              Clear selection
            </Button>
          </div>
          <form id="od-bulk-form" className="od-form" noValidate onSubmit={(event) => void submit(event)}>
            <p className="od-hint">Empty fields stay as they are on every selected day.</p>
            <div className="od-form__2">
              <TextInput id="od-bulk-start" type="time" step={900} labelText="Start" {...form.register('start')} />
              <TextInput id="od-bulk-end" type="time" step={900} labelText="End" {...form.register('end')} />
            </div>
            {multi > 0 && (
              <p className="od-hint">
                {plural(multi, 'day has', 'days have')} several timeslots and keep{multi === 1 ? 's' : ''} their times.
              </p>
            )}
            {toggled(
              'changeSupervisorPlaces',
              'supervisor places',
              <Controller
                control={form.control}
                name="supervisorPlaces"
                render={({ field }) => (
                  <NumberField
                    id="od-bulk-sup"
                    label="Supervisor places"
                    value={field.value}
                    onChange={field.onChange}
                  />
                )}
              />,
            )}
            {toggled(
              'changeTraineePlaces',
              'trainee places',
              <Controller
                control={form.control}
                name="traineePlaces"
                render={({ field }) => (
                  <NumberField id="od-bulk-tr" label="Trainee places" value={field.value} onChange={field.onChange} />
                )}
              />,
            )}
            {toggled(
              'changeSupervisorRoles',
              'who may take supervisor places',
              <Controller
                control={form.control}
                name="supervisorRoleIds"
                render={({ field }) => (
                  <RoleMultiSelect
                    id="od-bulk-sup-roles"
                    titleText="Extra roles (any one suffices)"
                    label="Any supervisor"
                    roles={[...roles]}
                    selectedRoleIds={field.value}
                    onChange={field.onChange}
                  />
                )}
              />,
            )}
            {toggled(
              'changeTraineeRoles',
              'who may take trainee places',
              <Controller
                control={form.control}
                name="traineeRoleIds"
                render={({ field }) => (
                  <RoleMultiSelect
                    id="od-bulk-tr-roles"
                    titleText="Extra roles (any one suffices)"
                    label="Any trainee"
                    roles={[...roles]}
                    selectedRoleIds={field.value}
                    onChange={field.onChange}
                  />
                )}
              />,
            )}
            {inSeries > 0 && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title={`${plural(inSeries, 'day belongs', 'days belong')} to a series.`}
                subtitle="Changing times, places or restrictions here takes them out of the series."
              />
            )}
            {signed > 0 && notifies && (
              <p className="od-hint">
                {plural(signed, 'sign-up')} on these days. People get a message when the time changes.
              </p>
            )}
            {applied && (
              <p className="od-field-error" role="alert">
                {applied}
              </p>
            )}
            <div>
              <Button kind="danger--ghost" size="sm" onClick={onRemove}>
                {draftPeriod ? 'Delete' : 'Cancel'} {plural(selected.length, 'open day')}
              </Button>
            </div>
          </form>
        </>
      )}
    </FormPanel>
  );
}
