import {
  Button,
  Checkbox,
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
import { useMutation } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type { EventRequirement, EventRole } from '../../api/generated/models';
import { saveShiftPositions } from './positions';
import { useLatestCallback } from '../../app/useLatestCallback';
import { eventMutationMessage } from './errors';
import { DialogProps } from './eventDialogProps';

type RequirementValues = {
  name: string;
  description: string;
  requiredCount: number;
  eligibilityMode: EventRequirement['eligibilityMode'];
  eligibleRoleIds: string[];
};

export function RequirementEditDialog({
  eventId,
  requirement,
  roles,
  open = true,
  onClose,
  onSaved,
  onDirtyChange,
}: DialogProps & { requirement: EventRequirement; roles: EventRole[] }) {
  const formId = `edit-event-requirement-${requirement.id}`;
  const form = useForm<RequirementValues>({
    defaultValues: {
      name: requirement.name,
      description: requirement.description ?? '',
      requiredCount: requirement.requiredCount,
      eligibilityMode: requirement.eligibilityMode,
      eligibleRoleIds: requirement.eligibleRoleIds,
    },
  });
  const mode = form.watch('eligibilityMode');
  const selectedRoles = form.watch('eligibleRoleIds');
  const mutation = useMutation({
    mutationFn: (value: RequirementValues) =>
      saveShiftPositions(eventId, requirement.shiftId, (positions) =>
        positions.map((position) =>
          position.id === requirement.id
            ? {
                id: requirement.id,
                name: value.name,
                description: value.description || null,
                requiredCount: value.requiredCount,
                eligibilityMode: value.eligibilityMode,
                eligibleRoleIds: value.eligibilityMode === 'roles' ? value.eligibleRoleIds : [],
              }
            : position,
        ),
      ),
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
      <ModalHeader title="Edit requirement" />
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
            <Controller
              name="name"
              control={form.control}
              rules={{ required: true }}
              render={({ field }) => <TextInput {...field} id={`${formId}-name`} labelText="Name" required />}
            />
            <Controller
              name="description"
              control={form.control}
              render={({ field }) => (
                <TextArea {...field} id={`${formId}-description`} labelText="Description (optional)" />
              )}
            />
            <Controller
              name="requiredCount"
              control={form.control}
              rules={{ required: true, min: 1, max: 1000 }}
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
            <Controller
              name="eligibilityMode"
              control={form.control}
              render={({ field }) => (
                <Select
                  {...field}
                  id={`${formId}-eligibility`}
                  labelText="Eligibility"
                  onChange={(event) => {
                    field.onChange(event);
                    if (event.target.value === 'anyone') form.setValue('eligibleRoleIds', [], { shouldDirty: true });
                  }}
                >
                  <SelectItem value="anyone" text="Anyone" />
                  <SelectItem value="roles" text="Selected roles" />
                </Select>
              )}
            />
            {mode === 'roles' && (
              <fieldset>
                <legend>Eligible roles</legend>
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
          Save changes
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}
