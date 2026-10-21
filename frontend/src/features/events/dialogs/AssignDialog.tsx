import {
  Checkbox,
  ContentSwitcher,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  Switch,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { createEventAssignment, moveEventAssignment } from '../../../api/generated/events/events';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { FieldRow, FormSection, FormSections, KeyValueList } from '../components/FormSection';
import { PersonCombo, type PersonChoice } from '../components/PersonCombo';
import { eventMutationMessage, isConflict } from '../errors';
import { fmtDay, fmtRange } from '../format';
import { eventShiftsQueryOptions, invalidateEvents } from '../queries';

type Values = {
  shiftId: string;
  requirementId: string;
  entry: 'person' | 'free';
  person: PersonChoice | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  override: boolean;
};

export type MoveTarget = {
  assignmentId: string;
  version: number;
  shiftId: string;
  requirementId: string;
  name: string;
  contact: string;
};

/** Assigns a helper to a place, or moves an existing assignment (the person is fixed then). */
export function AssignDialog({
  eventId,
  shiftId,
  requirementId,
  move,
  onClose,
}: {
  eventId: string;
  shiftId?: string;
  requirementId?: string;
  move?: MoveTarget;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const shiftsQuery = useQuery(eventShiftsQueryOptions(eventId));
  const shifts = (shiftsQuery.data?.items ?? []).filter((shift) => shift.status !== 'cancelled');
  const form = useForm<Values>({
    defaultValues: {
      shiftId: move?.shiftId ?? shiftId ?? '',
      requirementId: move?.requirementId ?? requirementId ?? '',
      entry: 'person',
      person: null,
      firstName: '',
      lastName: '',
      email: '',
      phone: '',
      override: false,
    },
  });
  const values = form.watch();
  const selectedShift = shifts.find((shift) => shift.id === (values.shiftId || shifts[0]?.id));
  const activeShiftId = selectedShift?.id ?? '';
  const positions = selectedShift?.requirements ?? [];
  const activeRequirementId = positions.some((p) => p.id === values.requirementId)
    ? values.requirementId
    : (positions[0]?.id ?? '');
  const mutation = useMutation({
    mutationFn: (value: Values) =>
      move
        ? moveEventAssignment(eventId, move.assignmentId, {
            shiftId: activeShiftId,
            requirementId: activeRequirementId,
            overrideConflict: value.override,
            expectedVersion: move.version,
          })
        : createEventAssignment(eventId, {
            shiftId: activeShiftId,
            requirementId: activeRequirementId,
            personId: value.entry === 'person' ? (value.person?.id ?? null) : null,
            firstName: value.entry === 'free' ? value.firstName.trim() : undefined,
            lastName: value.entry === 'free' ? value.lastName.trim() : undefined,
            email: value.entry === 'free' ? value.email.trim() || null : null,
            phone: value.entry === 'free' ? value.phone.trim() || null : null,
            overrideConflict: value.override,
          }),
    onSuccess: async () => {
      await invalidateEvents(client);
      onClose();
    },
  });
  const close = useLatestCallback(() => {
    if (!mutation.isPending) onClose();
  });
  const conflict = isConflict(mutation.error);
  const unchanged = Boolean(move && move.shiftId === activeShiftId && move.requirementId === activeRequirementId);
  const noWho =
    !move &&
    (values.entry === 'person'
      ? !values.person
      : !values.firstName.trim() || !values.lastName.trim() || !(values.email.trim() || values.phone.trim()));
  const blocked = !activeShiftId || !activeRequirementId || unchanged || noWho || (conflict && !values.override);
  const submit = form.handleSubmit((value) => {
    if (!mutation.isPending) mutation.mutate(value);
  });

  return (
    <Modal
      open
      size="md"
      modalHeading={move ? `Move ${move.name}` : 'Assign helper'}
      modalLabel="Helpers"
      primaryButtonText={mutation.isPending ? 'Saving…' : move ? 'Move helper' : 'Assign helper'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending || blocked}
      preventCloseOnClickOutside
      onRequestClose={close}
      onRequestSubmit={() => void submit()}
    >
      <FormSections>
        {mutation.isError && !conflict && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={move ? 'Helper not moved' : 'Helper not assigned'}
            subtitle={eventMutationMessage(mutation.error)}
          />
        )}
        <FormSection title="Where">
          <FieldRow>
            <Select
              id="ev-assign-shift"
              labelText="Shift"
              value={activeShiftId}
              onChange={(event) => {
                form.setValue('shiftId', event.target.value);
                form.setValue('requirementId', '');
                form.setValue('override', false);
                mutation.reset();
              }}
            >
              {shifts.map((shift) => (
                <SelectItem
                  key={shift.id}
                  value={shift.id}
                  text={`${shift.name} · ${fmtDay(shift.startsAt)}, ${fmtRange(shift.startsAt, shift.endsAt)}`}
                />
              ))}
            </Select>
            <Select
              id="ev-assign-position"
              labelText="Position"
              value={activeRequirementId}
              onChange={(event) => {
                form.setValue('requirementId', event.target.value);
                form.setValue('override', false);
                mutation.reset();
              }}
            >
              {positions.map((position) => {
                const filled = position.filledCount - (move?.requirementId === position.id ? 1 : 0);
                return (
                  <SelectItem
                    key={position.id}
                    value={position.id}
                    disabled={filled >= position.requiredCount}
                    text={`${position.name} (${filled}/${position.requiredCount})`}
                  />
                );
              })}
            </Select>
          </FieldRow>
          {unchanged && <p className="ev-secondary">Choose another shift or position to move this helper.</p>}
        </FormSection>
        <FormSection title="Who">
          {move ? (
            <KeyValueList
              label="Helper"
              rows={[
                ['Name', move.name],
                ['Contact', move.contact || 'No contact details'],
              ]}
            />
          ) : (
            <>
              <ContentSwitcher
                size="md"
                selectedIndex={values.entry === 'person' ? 0 : 1}
                onChange={({ name }) => {
                  form.setValue('entry', name as Values['entry']);
                  form.setValue('override', false);
                  mutation.reset();
                }}
              >
                <Switch name="person" text="Existing person" />
                <Switch name="free" text="Someone new" />
              </ContentSwitcher>
              {values.entry === 'person' ? (
                <Controller
                  name="person"
                  control={form.control}
                  render={({ field }) => (
                    <PersonCombo
                      id="ev-assign-person"
                      titleText="Person"
                      value={field.value}
                      onChange={(choice) => {
                        field.onChange(choice);
                        form.setValue('override', false);
                        mutation.reset();
                      }}
                    />
                  )}
                />
              ) : (
                <Stack gap={5}>
                  <FieldRow>
                    <TextInput id="ev-assign-first" labelText="First name" {...form.register('firstName')} />
                    <TextInput id="ev-assign-last" labelText="Last name" {...form.register('lastName')} />
                  </FieldRow>
                  <FieldRow>
                    <TextInput id="ev-assign-email" type="email" labelText="Email" {...form.register('email')} />
                    <TextInput
                      id="ev-assign-phone"
                      type="tel"
                      labelText="Phone"
                      helperText="Email or phone is required."
                      {...form.register('phone')}
                    />
                  </FieldRow>
                </Stack>
              )}
            </>
          )}
        </FormSection>
        {conflict && (
          <Stack gap={4}>
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Schedule conflict"
              subtitle="This person already has an overlapping shift."
            />
            <Controller
              name="override"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  id="ev-assign-override"
                  labelText="Override the conflict"
                  helperText="The override is recorded in the audit log and marked on the helper."
                  checked={field.value}
                  onChange={(_, { checked }) => field.onChange(checked)}
                />
              )}
            />
          </Stack>
        )}
      </FormSections>
    </Modal>
  );
}
