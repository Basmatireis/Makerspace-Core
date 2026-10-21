import { Add, TrashCan } from '@carbon/icons-react';
import {
  Button,
  Checkbox,
  IconButton,
  InlineNotification,
  Modal,
  MultiSelect,
  NumberInput,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  TextArea,
  TextInput,
  TimePicker,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { createEventShift, updateEventShift } from '../../../api/generated/events/events';
import type { Event, EventRole, EventSession, EventShift, EventShiftStatus } from '../../../api/generated/models';
import { DateInput, DateTimeInput } from '../../../app/DateInput';
import { dateInAppTimeZone, instantToZonedDateTimeValue, timeInAppTimeZone } from '../../../app/dateTime';
import { UnsavedChangesDialog } from '../../../app/UnsavedChangesDialog';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import { FieldRow, FormSection, FormSections, OvernightHint } from '../components/FormSection';
import { eventMutationMessage } from '../errors';
import { endDayOf, fmtDay, overnightHint, toInstant, toISO } from '../format';
import { eventRolesQueryOptions, invalidateEvents } from '../queries';
import { shiftBody } from '../requestBodies';

type PositionValues = {
  id: string | null;
  name: string;
  description: string | null;
  requiredCount: number;
  restricted: boolean;
  roleIds: string[];
  /** Active helpers: the position cannot shrink below them or be removed. */
  filled: number;
};
type Values = {
  name: string;
  description: string;
  sessionId: string;
  date: string;
  start: string;
  endDate: string;
  end: string;
  limited: boolean;
  opensAt: string;
  closesAt: string;
  isPublic: boolean;
  status: Exclude<EventShiftStatus, 'cancelled'>;
  positions: PositionValues[];
};

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUS_OPTIONS: Array<{ value: Values['status']; label: string; hint: string }> = [
  { value: 'draft', label: 'Draft', hint: 'Only the team sees it. Nobody can sign up yet.' },
  {
    value: 'open',
    label: 'Signup open',
    hint: 'Helpers can sign up in the app and, if the shift is public, on the public page.',
  },
  { value: 'closed', label: 'Signup closed', hint: 'Visible, but no new signups.' },
];

/** Adds or edits a helper shift with its positions. Sections: Basics, When, Positions, Signup and visibility. */
export function ShiftDialog({
  event,
  shift,
  session,
  sessions,
  onClose,
}: {
  event: Event;
  shift?: EventShift;
  /** Preselected session when the shift is added from a session card. */
  session?: EventSession;
  sessions: EventSession[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const roles = useQuery(eventRolesQueryOptions());
  const roleItems: EventRole[] = roles.data?.items ?? [];
  const linked = shift ? sessions.find((item) => item.id === shift.sessionId) : session;
  const anchor =
    shift?.startsAt ?? linked?.startsAt ?? sessions[0]?.startsAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString();
  const startDate = dateInAppTimeZone(anchor);
  const cancelled = shift?.status === 'cancelled';
  const form = useForm<Values>({
    defaultValues: {
      name: shift?.name ?? '',
      description: shift?.description ?? '',
      sessionId: linked?.id ?? '',
      date: startDate,
      start: timeInAppTimeZone(shift?.startsAt ?? linked?.startsAt ?? anchor),
      endDate: shift ? dateInAppTimeZone(shift.endsAt) : linked ? dateInAppTimeZone(linked.endsAt) : startDate,
      end: shift
        ? timeInAppTimeZone(shift.endsAt)
        : linked
          ? timeInAppTimeZone(linked.endsAt)
          : timeInAppTimeZone(new Date(Date.parse(anchor) + 4 * 3_600_000)),
      limited: Boolean(shift?.signupOpensAt || shift?.signupClosesAt),
      opensAt: shift?.signupOpensAt ? instantToZonedDateTimeValue(shift.signupOpensAt) : '',
      closesAt: shift?.signupClosesAt ? instantToZonedDateTimeValue(shift.signupClosesAt) : '',
      isPublic: shift?.isPublic ?? false,
      status: shift && shift.status !== 'cancelled' ? shift.status : 'draft',
      positions: (shift?.requirements ?? []).map((requirement) => ({
        id: requirement.id,
        name: requirement.name,
        description: requirement.description ?? null,
        requiredCount: requirement.requiredCount,
        restricted: requirement.eligibilityMode === 'roles',
        roleIds: requirement.eligibleRoleIds,
        filled: requirement.filledCount,
      })),
    },
  });
  const rows = useFieldArray({ control: form.control, name: 'positions' });
  const guard = useUnsavedChanges({ isDirty: form.formState.isDirty });
  const save = useMutation({
    mutationFn: (value: Values) => {
      const input = {
        sessionId: value.sessionId || null,
        name: value.name.trim(),
        description: value.description.trim() || null,
        startsAt: toInstant(value.date, value.start),
        endsAt: toInstant(endDayOf(value.date, value.start, value.end, value.endDate), value.end),
        signupOpensAt: value.limited && value.opensAt ? toISO(value.opensAt) : null,
        signupClosesAt: value.limited && value.closesAt ? toISO(value.closesAt) : null,
        isPublic: value.isPublic,
        status: cancelled ? ('cancelled' as const) : value.status,
        requirements: value.positions.map((position) => ({
          id: position.id,
          name: position.name.trim(),
          description: position.description,
          requiredCount: position.requiredCount,
          eligibilityMode: position.restricted ? ('roles' as const) : ('anyone' as const),
          eligibleRoleIds: position.restricted ? position.roleIds : [],
        })),
      };
      return shift ? updateEventShift(event.id, shift.id, shiftBody(shift, input)) : createEventShift(event.id, input);
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
  const values = form.watch();
  const errors = form.formState.errors;

  const chooseSession = (id: string) => {
    form.setValue('sessionId', id, { shouldDirty: true });
    const chosen = sessions.find((item) => item.id === id);
    if (chosen && !shift) {
      form.setValue('date', dateInAppTimeZone(chosen.startsAt), { shouldDirty: true });
      form.setValue('start', timeInAppTimeZone(chosen.startsAt), { shouldDirty: true });
      form.setValue('endDate', dateInAppTimeZone(chosen.endsAt), { shouldDirty: true });
      form.setValue('end', timeInAppTimeZone(chosen.endsAt), { shouldDirty: true });
    }
  };

  return (
    <>
      <Modal
        open={!guard.dialogOpen}
        size="lg"
        modalHeading={shift ? 'Edit shift' : 'Add shift'}
        modalLabel={event.name}
        primaryButtonText={save.isPending ? 'Saving…' : shift ? 'Save shift' : 'Add shift'}
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
              title="The shift was not saved"
              subtitle={eventMutationMessage(save.error)}
            />
          )}
          <FormSection title="Basics">
            <TextInput
              id="ev-shift-name"
              labelText="Name"
              invalid={Boolean(errors.name)}
              invalidText="Enter a name."
              {...form.register('name', { validate: (value) => value.trim().length > 0 && value.length <= 200 })}
            />
            <TextArea
              id="ev-shift-description"
              labelText="Description (optional)"
              rows={2}
              maxLength={10000}
              {...form.register('description')}
            />
          </FormSection>

          <FormSection title="When">
            <Select
              id="ev-shift-session"
              labelText="Linked session"
              helperText="Picking one fills day and time. Shifts without a session, such as setup and teardown, are listed separately."
              value={values.sessionId}
              onChange={(e) => chooseSession(e.target.value)}
            >
              <SelectItem value="" text="No session" />
              {sessions.map((item) => (
                <SelectItem
                  key={item.id}
                  value={item.id}
                  text={`${item.name || 'Session'} · ${fmtDay(item.startsAt)} ${timeInAppTimeZone(item.startsAt)}`}
                />
              ))}
            </Select>
            <FieldRow cols={3}>
              <Controller
                name="date"
                control={form.control}
                rules={{ required: true }}
                render={({ field, fieldState }) => (
                  <DateInput
                    id="ev-shift-date"
                    labelText="Day"
                    value={field.value}
                    onChange={(next) => {
                      // The end day follows the start day until someone sets a different one.
                      if (form.getValues('endDate') === field.value)
                        form.setValue('endDate', next, { shouldDirty: true });
                      field.onChange(next);
                    }}
                    invalid={Boolean(fieldState.error)}
                    invalidText="Choose a day."
                  />
                )}
              />
              <TimePicker
                id="ev-shift-start"
                labelText="Start (24-hour)"
                placeholder="HH:MM"
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                invalid={Boolean(errors.start)}
                invalidText="Use HH:MM."
                {...form.register('start', { required: true, pattern: CLOCK })}
              />
              <TimePicker
                id="ev-shift-end"
                labelText="End (24-hour)"
                placeholder="HH:MM"
                pattern="([01][0-9]|2[0-3]):[0-5][0-9]"
                invalid={Boolean(errors.end)}
                invalidText="The end must be after the start."
                {...form.register('end', {
                  required: true,
                  pattern: CLOCK,
                  validate: (value, all) =>
                    `${endDayOf(all.date, all.start, value, all.endDate)}T${value}` > `${all.date}T${all.start}`,
                })}
              />
            </FieldRow>
            <OvernightHint text={overnightHint(values.date, values.start, values.end, values.endDate)} />
            {values.endDate !== values.date && (
              <Controller
                name="endDate"
                control={form.control}
                render={({ field }) => (
                  <DateInput id="ev-shift-end-date" labelText="Ends on" value={field.value} onChange={field.onChange} />
                )}
              />
            )}
          </FormSection>

          <FormSection title="Positions" hint="What helpers do in this shift and how many places each position has.">
            {rows.fields.length === 0 ? (
              <p className="ev-secondary evf-pos__empty">
                No positions yet. A shift needs at least one position before helpers can sign up.
              </p>
            ) : (
              <div className="evf-pos__list">
                <div className="evf-pos evf-pos--head" aria-hidden="true">
                  <span>Position</span>
                  <span>Places</span>
                  <span>Who can fill it</span>
                  <span />
                </div>
                {rows.fields.map((row, index) => {
                  const position = values.positions[index];
                  const rowErrors = errors.positions?.[index];
                  return (
                    <div key={row.id} className="evf-pos">
                      <TextInput
                        id={`ev-pos-name-${row.id}`}
                        labelText={`Name of position ${index + 1}`}
                        hideLabel
                        placeholder="e.g. Bar"
                        invalid={Boolean(rowErrors?.name)}
                        invalidText={rowErrors?.name?.message || 'Enter a name.'}
                        {...form.register(`positions.${index}.name`, {
                          validate: (value, all) => {
                            const name = value.trim().toLowerCase();
                            if (!name) return 'Enter a name.';
                            const same = all.positions.filter((p) => p.name.trim().toLowerCase() === name).length;
                            return same > 1 ? 'Position names must be different.' : true;
                          },
                        })}
                      />
                      <Controller
                        name={`positions.${index}.requiredCount`}
                        control={form.control}
                        render={({ field }) => (
                          <NumberInput
                            id={`ev-pos-count-${row.id}`}
                            label={`Places of position ${index + 1}`}
                            hideLabel
                            min={Math.max(1, position?.filled ?? 0)}
                            max={1000}
                            value={field.value}
                            helperText={position?.filled ? `${position.filled} filled` : undefined}
                            onChange={(_, { value }) => field.onChange(Number(value) || 1)}
                          />
                        )}
                      />
                      <Select
                        id={`ev-pos-who-${row.id}`}
                        labelText={`Who can fill position ${index + 1}`}
                        hideLabel
                        value={position?.restricted ? 'roles' : 'anyone'}
                        onChange={(e) =>
                          form.setValue(`positions.${index}.restricted`, e.target.value === 'roles', {
                            shouldDirty: true,
                          })
                        }
                      >
                        <SelectItem value="anyone" text="Anyone" />
                        <SelectItem value="roles" text="Members with roles" />
                      </Select>
                      <IconButton
                        kind="ghost"
                        size="md"
                        label={position?.filled ? 'Has helpers and cannot be removed' : 'Remove position'}
                        disabled={Boolean(position?.filled)}
                        onClick={() => rows.remove(index)}
                      >
                        <TrashCan />
                      </IconButton>
                      {position?.restricted && (
                        <div className="evf-pos__roles">
                          <Controller
                            name={`positions.${index}.roleIds`}
                            control={form.control}
                            rules={{ validate: (ids, all) => !all.positions[index]?.restricted || ids.length > 0 }}
                            render={({ field, fieldState }) => (
                              <MultiSelect<EventRole>
                                id={`ev-pos-roles-${row.id}`}
                                titleText={`Roles for position ${index + 1}`}
                                hideLabel
                                label="Choose roles"
                                items={roleItems}
                                itemToString={(item) => item?.name ?? ''}
                                selectedItems={roleItems.filter((role) => field.value.includes(role.id))}
                                invalid={Boolean(fieldState.error)}
                                invalidText="Choose at least one role."
                                onChange={({ selectedItems }) =>
                                  field.onChange((selectedItems ?? []).map((item) => item.id))
                                }
                              />
                            )}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <div>
              <Button
                kind="ghost"
                size="sm"
                renderIcon={Add}
                onClick={() =>
                  rows.append({
                    id: null,
                    name: '',
                    description: null,
                    requiredCount: 1,
                    restricted: false,
                    roleIds: [],
                    filled: 0,
                  })
                }
              >
                Add position
              </Button>
            </div>
          </FormSection>

          <FormSection title="Signup and visibility">
            <RadioButtonGroup
              legendText="Status"
              name="ev-shift-status"
              orientation="vertical"
              valueSelected={cancelled ? 'cancelled' : values.status}
              disabled={cancelled}
              onChange={(value) => form.setValue('status', value as Values['status'], { shouldDirty: true })}
            >
              {STATUS_OPTIONS.map((option) => (
                <RadioButton
                  key={option.value}
                  id={`ev-shift-status-${option.value}`}
                  value={option.value}
                  labelText={
                    <span className="evf-radio-label">
                      {option.label}
                      <span className="evf-radio-label__hint">{option.hint}</span>
                    </span>
                  }
                />
              ))}
              {cancelled && (
                <RadioButton
                  id="ev-shift-status-cancelled"
                  value="cancelled"
                  labelText={
                    <span className="evf-radio-label">
                      Cancelled
                      <span className="evf-radio-label__hint">
                        The status of a cancelled shift cannot be changed here.
                      </span>
                    </span>
                  }
                />
              )}
            </RadioButtonGroup>
            <Controller
              name="isPublic"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  id="ev-shift-public"
                  labelText="Show on the public page"
                  helperText={
                    field.value
                      ? 'Public: visitors can see the shift.'
                      : 'Internal: only the team and signed-in helpers see the shift.'
                  }
                  checked={field.value}
                  onChange={(_, { checked }) => field.onChange(checked)}
                />
              )}
            />
            <Controller
              name="limited"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  id="ev-shift-limited"
                  labelText="Limit the signup period"
                  helperText="Otherwise signup follows the status above."
                  checked={field.value}
                  onChange={(_, { checked }) => field.onChange(checked)}
                />
              )}
            />
            {values.limited && (
              <FieldRow>
                <Controller
                  name="opensAt"
                  control={form.control}
                  render={({ field }) => (
                    <DateTimeInput
                      id="ev-shift-opens"
                      labelText="Signup opens"
                      value={field.value}
                      onChange={field.onChange}
                    />
                  )}
                />
                <Controller
                  name="closesAt"
                  control={form.control}
                  rules={{ validate: (value, all) => !value || !all.opensAt || value > all.opensAt }}
                  render={({ field, fieldState }) => (
                    <div>
                      <DateTimeInput
                        id="ev-shift-closes"
                        labelText="Signup closes"
                        value={field.value}
                        onChange={field.onChange}
                      />
                      {fieldState.error && <p className="evf-error">Signup must close after it opens.</p>}
                    </div>
                  )}
                />
              </FieldRow>
            )}
          </FormSection>
        </FormSections>
      </Modal>
      <UnsavedChangesDialog guard={guard} />
    </>
  );
}
