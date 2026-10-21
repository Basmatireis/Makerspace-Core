import {
  Button,
  Checkbox,
  ComboBox,
  ComposedModal,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  NumberInput,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { createEventAssignment, listEventPeople } from '../../api/generated/events/events';
import type {
  EventAssignmentInput,
  EventPersonOption,
  EventRequirement,
  EventRole,
  EventShift,
} from '../../api/generated/models';
import { useLatestCallback } from '../../app/useLatestCallback';
import { eventMutationMessage } from './errors';
import { saveShiftPositions } from './positions';

type StaffingDialogProps = {
  eventId: string;
  open?: boolean;
  onClose: () => void;
  onSaved: () => Promise<unknown>;
  onDirtyChange?: (dirty: boolean) => void;
};

type RequirementValues = {
  name: string;
  description: string;
  requiredCount: number;
  eligibilityMode: EventRequirement['eligibilityMode'];
  eligibleRoleIds: string[];
};

export function RequirementCreateDialog({
  eventId,
  shift,
  roles,
  open = true,
  onClose,
  onSaved,
  onDirtyChange,
}: StaffingDialogProps & { shift: EventShift; roles: EventRole[] }) {
  const formId = `create-event-requirement-${shift.id}`;
  const form = useForm<RequirementValues>({
    defaultValues: { name: '', description: '', requiredCount: 1, eligibilityMode: 'anyone', eligibleRoleIds: [] },
  });
  const mode = form.watch('eligibilityMode');
  const selectedRoles = form.watch('eligibleRoleIds');
  const mutation = useMutation({
    mutationFn: (value: RequirementValues) =>
      saveShiftPositions(eventId, shift.id, (positions) => [
        ...positions,
        {
          name: value.name.trim(),
          description: value.description || null,
          requiredCount: value.requiredCount,
          eligibilityMode: value.eligibilityMode,
          eligibleRoleIds: value.eligibilityMode === 'roles' ? value.eligibleRoleIds : [],
        },
      ]),
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
      <ModalHeader title="Add requirement" label={shift.name} />
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
                title="Requirement not saved"
                subtitle={eventMutationMessage(mutation.error)}
              />
            )}
            <TextInput
              id={`${formId}-name`}
              labelText="Name"
              placeholder="Laser cutter supervision"
              invalid={Boolean(form.formState.errors.name)}
              invalidText="Enter a name."
              {...form.register('name', { validate: (value) => Boolean(value.trim()) })}
            />
            <TextArea
              id={`${formId}-description`}
              labelText="Description (optional)"
              {...form.register('description')}
            />
            <Controller
              name="requiredCount"
              control={form.control}
              rules={{ min: 1, max: 1000 }}
              render={({ field }) => (
                <NumberInput
                  id={`${formId}-count`}
                  label="Required people"
                  min={1}
                  max={1000}
                  value={field.value}
                  onChange={(_, data) => field.onChange(Number(data.value))}
                />
              )}
            />
            <Select
              id={`${formId}-eligibility`}
              labelText="Who can fill it"
              {...form.register('eligibilityMode', {
                onChange: (event) => {
                  if (event.target.value === 'anyone') form.setValue('eligibleRoleIds', []);
                },
              })}
            >
              <SelectItem value="anyone" text="Anyone" />
              <SelectItem value="roles" text="Selected roles" />
            </Select>
            {mode === 'roles' && (
              <fieldset className="cds--fieldset">
                <legend className="cds--label">Eligible roles</legend>
                <Stack gap={3}>
                  {roles.map((role) => (
                    <Checkbox
                      key={role.id}
                      id={`${formId}-role-${role.id}`}
                      labelText={role.name}
                      checked={selectedRoles.includes(role.id)}
                      onChange={(_, data) =>
                        form.setValue(
                          'eligibleRoleIds',
                          data.checked ? [...selectedRoles, role.id] : selectedRoles.filter((id) => id !== role.id),
                          { shouldDirty: true },
                        )
                      }
                    />
                  ))}
                </Stack>
              </fieldset>
            )}
          </Stack>
        </form>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={mutation.isPending} onClick={close}>
          Cancel
        </Button>
        <Button
          type="submit"
          form={formId}
          disabled={mutation.isPending || (mode === 'roles' && selectedRoles.length === 0)}
        >
          {mutation.isPending ? 'Adding…' : 'Add requirement'}
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}

type AssignmentValues = {
  person: EventPersonOption | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  overrideConflict: boolean;
};

export function AssignHelperDialog({
  eventId,
  requirement,
  open = true,
  onClose,
  onSaved,
  onDirtyChange,
}: StaffingDialogProps & { requirement: EventRequirement }) {
  const formId = `assign-event-helper-${requirement.id}`;
  const [peopleSearch, setPeopleSearch] = useState('');
  const people = useQuery({
    queryKey: ['events', 'people', peopleSearch],
    queryFn: ({ signal }) => listEventPeople({ search: peopleSearch || undefined }, { signal }),
    placeholderData: keepPreviousData,
  });
  const form = useForm<AssignmentValues>({
    defaultValues: { person: null, firstName: '', lastName: '', email: '', phone: '', overrideConflict: false },
  });
  const person = form.watch('person');
  const mutation = useMutation({
    mutationFn: (value: AssignmentValues) =>
      createEventAssignment(eventId, {
        shiftId: requirement.shiftId,
        requirementId: requirement.id,
        personId: value.person?.id ?? null,
        firstName: value.person ? undefined : value.firstName.trim(),
        lastName: value.person ? undefined : value.lastName.trim(),
        email: value.person ? null : value.email.trim() || null,
        phone: value.person ? null : value.phone.trim() || null,
        overrideConflict: value.overrideConflict,
      } as EventAssignmentInput),
    onSuccess: onSaved,
  });
  useEffect(() => {
    onDirtyChange?.(form.formState.isDirty);
  }, [form.formState.isDirty, onDirtyChange]);
  const close = useLatestCallback(() => {
    if (!mutation.isPending) onClose();
    return false;
  });
  const external = !person;
  // External helpers need a way to be contacted; known people already have one.
  const contactRule = (_: string, values: AssignmentValues) =>
    Boolean(values.person || values.email.trim() || values.phone.trim());

  return (
    <ComposedModal open={open} onClose={close} size="sm" preventCloseOnClickOutside>
      <ModalHeader title="Assign helper" label={requirement.name} />
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
                title="Helper not assigned"
                subtitle={eventMutationMessage(mutation.error)}
              />
            )}
            <Controller
              name="person"
              control={form.control}
              render={({ field }) => (
                <ComboBox
                  id={`${formId}-person`}
                  titleText="Known person"
                  helperText="Leave empty to add an external helper."
                  placeholder="Search people"
                  items={people.data?.items ?? []}
                  itemToString={(item) => (item ? `${item.firstName} ${item.lastName}` : '')}
                  selectedItem={field.value}
                  onInputChange={setPeopleSearch}
                  onChange={({ selectedItem }) => field.onChange(selectedItem ?? null)}
                />
              )}
            />
            {external && (
              <>
                <TextInput
                  id={`${formId}-first`}
                  labelText="First name"
                  invalid={Boolean(form.formState.errors.firstName)}
                  invalidText="Enter a first name."
                  {...form.register('firstName', {
                    validate: (value, values) => Boolean(values.person || value.trim()),
                  })}
                />
                <TextInput
                  id={`${formId}-last`}
                  labelText="Last name"
                  invalid={Boolean(form.formState.errors.lastName)}
                  invalidText="Enter a last name."
                  {...form.register('lastName', {
                    validate: (value, values) => Boolean(values.person || value.trim()),
                  })}
                />
                <TextInput
                  id={`${formId}-email`}
                  type="email"
                  labelText="Email"
                  invalid={Boolean(form.formState.errors.email)}
                  invalidText="Enter an email or phone number."
                  {...form.register('email', { validate: contactRule })}
                />
                <TextInput id={`${formId}-phone`} type="tel" labelText="Phone" {...form.register('phone')} />
              </>
            )}
            <Controller
              name="overrideConflict"
              control={form.control}
              render={({ field }) => (
                <Checkbox
                  id={`${formId}-override`}
                  labelText="Override a scheduling conflict (audited)"
                  checked={field.value}
                  onChange={(_, data) => field.onChange(data.checked)}
                />
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
          {mutation.isPending ? 'Assigning…' : 'Assign'}
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}
