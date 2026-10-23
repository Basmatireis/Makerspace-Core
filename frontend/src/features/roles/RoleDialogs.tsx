import { useEffect, type RefObject } from 'react';
import {
  Button,
  Checkbox,
  ComposedModal,
  Form,
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
import { Controller, useForm, type Control } from 'react-hook-form';
import type { CreateRoleRequest, Role, StaffingLevel, UpdateRoleRequest } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { normalizePermissionGrants } from '../auth/permissions';

type RoleForm = {
  name: string;
  description: string;
  copyFromRoleId: string;
  profileImageRequired: boolean;
  laborordnungMode: Role['laborordnungMode'];
  staffingLevel: StaffingLevel | 'none';
  // Empty means: use the general minimum.
  minOpenDaysPerSemester: number | string;
};

const MIN_OPEN_DAYS_LIMIT = 20;

function validMinimum(value: number | string): true | string {
  if (value === '') return true;
  const number = typeof value === 'number' ? value : Number(value);
  return (
    (Number.isInteger(number) && number >= 0 && number <= MIN_OPEN_DAYS_LIMIT) ||
    `Enter a whole number from 0 to ${MIN_OPEN_DAYS_LIMIT}, or leave it empty.`
  );
}

/** The role's own open-day minimum; only roles with a staffing level can have one. */
function minimumFromForm(values: RoleForm): number | null {
  if (values.staffingLevel === 'none' || values.minOpenDaysPerSemester === '') return null;
  return Number(values.minOpenDaysPerSemester);
}

function OpenDayMinimumField({
  id,
  control,
  generalMinimum,
}: {
  id: string;
  control: Control<RoleForm>;
  generalMinimum?: number;
}) {
  return (
    <Controller
      control={control}
      name="minOpenDaysPerSemester"
      rules={{ validate: validMinimum }}
      render={({ field, fieldState }) => (
        <NumberInput
          id={id}
          label="Open days per semester (optional)"
          min={0}
          max={MIN_OPEN_DAYS_LIMIT}
          step={1}
          allowEmpty
          value={field.value}
          helperText={`Leave empty to use the general minimum${generalMinimum === undefined ? '' : ` of ${generalMinimum}`}. People with several roles get the lowest minimum of their roles.`}
          invalid={Boolean(fieldState.error)}
          invalidText={fieldState.error?.message}
          onChange={(_event, { value }) => field.onChange(value)}
        />
      )}
    />
  );
}

export function CreateRoleDialog({
  open,
  roles,
  generalMinimum,
  isPending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  roles: Role[];
  /** The general open-day minimum, when the viewer may read the open-day requirements. */
  generalMinimum?: number;
  isPending: boolean;
  error?: Error | null;
  onClose: () => void;
  onSubmit: (request: CreateRoleRequest) => void;
}) {
  const form = useForm<RoleForm>({ defaultValues: emptyRoleForm });
  useEffect(() => {
    if (open) form.reset(emptyRoleForm);
  }, [form, open]);
  const submit = form.handleSubmit((values) => {
    const source = roles.find((role) => role.id === values.copyFromRoleId);
    onSubmit({
      name: values.name.trim(),
      description: values.description.trim() || null,
      permissionGrants: normalizePermissionGrants(source?.permissionGrants ?? []),
      profileImageRequired: values.profileImageRequired,
      laborordnungMode: values.laborordnungMode,
      staffingLevel: values.staffingLevel === 'none' ? null : values.staffingLevel,
      minOpenDaysPerSemester: minimumFromForm(values),
    });
  });

  return (
    <ComposedModal open={open} onClose={onClose} size="sm" preventCloseOnClickOutside>
      <ModalHeader title="Create role" closeModal={onClose} />
      <ModalBody hasScrollingContent>
        <Form id="create-role-form" onSubmit={submit} noValidate>
          <Stack gap={6}>
            {error && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Role not created"
                subtitle={error.message}
              />
            )}
            <TextInput
              id="create-role-name"
              labelText="Role name"
              placeholder="e.g. Workshop lead"
              invalid={Boolean(form.formState.errors.name)}
              invalidText={form.formState.errors.name?.message}
              {...form.register('name', {
                required: 'Enter a role name.',
                maxLength: { value: 100, message: 'Use at most 100 characters.' },
              })}
            />
            <TextArea
              id="create-role-description"
              labelText="Description (optional)"
              placeholder="Brief description of this role"
              rows={3}
              invalid={Boolean(form.formState.errors.description)}
              invalidText={form.formState.errors.description?.message}
              {...form.register('description', { maxLength: { value: 500, message: 'Use at most 500 characters.' } })}
            />
            <Select
              id="copy-role-permissions"
              labelText="Copy permissions from (optional)"
              {...form.register('copyFromRoleId')}
            >
              <SelectItem value="" text="— Start from scratch —" />
              {roles.map((role) => (
                <SelectItem key={role.id} value={role.id} text={role.name} />
              ))}
            </Select>
            <div>
              <h3 className="role-dialog__section-title">Role requirements</h3>
              <p className="section-description">These existing role behaviors are independent from permissions.</p>
            </div>
            <Checkbox
              id="create-role-profile-image-required"
              labelText="Require a profile image"
              checked={form.watch('profileImageRequired')}
              onChange={(_, data) => form.setValue('profileImageRequired', data.checked, { shouldDirty: true })}
            />
            <Select
              id="create-role-lab-rules"
              labelText="Lab Rules requirement"
              value={form.watch('laborordnungMode')}
              onChange={(event) =>
                form.setValue('laborordnungMode', event.target.value as Role['laborordnungMode'], { shouldDirty: true })
              }
            >
              <SelectItem value="not_required" text="Not required" />
              <SelectItem value="warning" text="Warning" />
              <SelectItem value="blocking" text="Block admission" />
            </Select>
            <Select
              id="create-role-staffing-level"
              labelText="Open day staffing"
              value={form.watch('staffingLevel')}
              onChange={(event) =>
                form.setValue('staffingLevel', event.target.value as StaffingLevel | 'none', { shouldDirty: true })
              }
            >
              <SelectItem value="none" text="None" />
              <SelectItem value="supervisor" text="Supervisor" />
              <SelectItem value="trainee" text="Trainee" />
            </Select>
            {form.watch('staffingLevel') !== 'none' && (
              <OpenDayMinimumField
                id="create-role-min-open-days"
                control={form.control}
                generalMinimum={generalMinimum}
              />
            )}
          </Stack>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" type="button" disabled={isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form="create-role-form" disabled={isPending}>
          {isPending ? 'Creating…' : 'Create role'}
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}

export function RoleSettingsDialog({
  role,
  generalMinimum,
  isPending,
  error,
  onClose,
  onSubmit,
}: {
  role?: Role;
  /** The general open-day minimum, when the viewer may read the open-day requirements. */
  generalMinimum?: number;
  isPending: boolean;
  error?: Error | null;
  onClose: () => void;
  onSubmit: (request: UpdateRoleRequest) => void;
}) {
  const form = useForm<RoleForm>({ defaultValues: emptyRoleForm });
  useEffect(() => {
    if (role)
      form.reset({
        name: role.name,
        description: role.description ?? '',
        copyFromRoleId: '',
        profileImageRequired: role.profileImageRequired,
        laborordnungMode: role.laborordnungMode,
        staffingLevel: role.staffingLevel ?? 'none',
        minOpenDaysPerSemester: role.minOpenDaysPerSemester ?? '',
      });
  }, [form, role]);
  const submit = form.handleSubmit((values) => {
    if (!role) return;
    onSubmit({
      expectedVersion: role.version,
      name: values.name.trim(),
      description: values.description.trim() || null,
      profileImageRequired: values.profileImageRequired,
      laborordnungMode: values.laborordnungMode,
      staffingLevel: values.staffingLevel === 'none' ? null : values.staffingLevel,
      minOpenDaysPerSemester: minimumFromForm(values),
    });
  });
  return (
    <ComposedModal open={Boolean(role)} onClose={onClose} size="sm" preventCloseOnClickOutside>
      <ModalHeader title="Edit role" closeModal={onClose} />
      <ModalBody hasScrollingContent>
        {role && (
          <Form id="edit-role-form" onSubmit={submit} noValidate>
            <Stack gap={6}>
              {error && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Role not updated"
                  subtitle={error.message}
                />
              )}
              <TextInput
                id="edit-role-name"
                labelText="Role name"
                invalid={Boolean(form.formState.errors.name)}
                invalidText={form.formState.errors.name?.message}
                {...form.register('name', {
                  required: 'Enter a role name.',
                  maxLength: { value: 100, message: 'Use at most 100 characters.' },
                })}
              />
              <TextArea
                id="edit-role-description"
                labelText="Description (optional)"
                rows={3}
                invalid={Boolean(form.formState.errors.description)}
                invalidText={form.formState.errors.description?.message}
                {...form.register('description', { maxLength: { value: 500, message: 'Use at most 500 characters.' } })}
              />
              <Checkbox
                id="edit-role-profile-image-required"
                labelText="Require a profile image"
                checked={form.watch('profileImageRequired')}
                onChange={(_, data) => form.setValue('profileImageRequired', data.checked, { shouldDirty: true })}
              />
              <Select
                id="edit-role-lab-rules"
                labelText="Lab Rules requirement"
                value={form.watch('laborordnungMode')}
                onChange={(event) =>
                  form.setValue('laborordnungMode', event.target.value as Role['laborordnungMode'], {
                    shouldDirty: true,
                  })
                }
              >
                <SelectItem value="not_required" text="Not required" />
                <SelectItem value="warning" text="Warning" />
                <SelectItem value="blocking" text="Block admission" />
              </Select>
              <Select
                id="edit-role-staffing-level"
                labelText="Open day staffing"
                value={form.watch('staffingLevel')}
                onChange={(event) =>
                  form.setValue('staffingLevel', event.target.value as StaffingLevel | 'none', { shouldDirty: true })
                }
              >
                <SelectItem value="none" text="None" />
                <SelectItem value="supervisor" text="Supervisor" />
                <SelectItem value="trainee" text="Trainee" />
              </Select>
              {form.watch('staffingLevel') !== 'none' && (
                <OpenDayMinimumField
                  id="edit-role-min-open-days"
                  control={form.control}
                  generalMinimum={generalMinimum}
                />
              )}
            </Stack>
          </Form>
        )}
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" type="button" disabled={isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" form="edit-role-form" disabled={isPending}>
          {isPending ? 'Saving…' : 'Save role'}
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}

export function DeleteRoleDialog({
  role,
  launcherButtonRef,
  isPending,
  error,
  onClose,
  onConfirm,
}: {
  role?: Role;
  launcherButtonRef?: RefObject<HTMLElement | null>;
  isPending: boolean;
  error?: Error | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!role) return null;

  return (
    <DestructiveActionDialog
      open
      title="Delete role?"
      confirmLabel="Delete role"
      launcherButtonRef={launcherButtonRef}
      pending={isPending}
      error={error?.message}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p>
        {role.name} will be removed from every person who has it. The role and its permission grants will be permanently
        deleted. This cannot be undone.
      </p>
    </DestructiveActionDialog>
  );
}

const emptyRoleForm: RoleForm = {
  name: '',
  description: '',
  copyFromRoleId: '',
  profileImageRequired: false,
  laborordnungMode: 'not_required',
  staffingLevel: 'none',
  minOpenDaysPerSemester: '',
};
