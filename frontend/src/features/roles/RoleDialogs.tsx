import { useEffect } from 'react';
import {
  Button,
  Checkbox,
  ComposedModal,
  Form,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
} from '@carbon/react';
import { useForm } from 'react-hook-form';
import type { CreateRoleRequest, Role, UpdateRoleRequest } from '../../api/generated/models';
import { normalizePermissionGrants } from '../auth/permissions';

type RoleForm = {
  name: string;
  description: string;
  copyFromRoleId: string;
  profileImageRequired: boolean;
  laborordnungMode: Role['laborordnungMode'];
  supervisorDashboard: boolean;
};

export function CreateRoleDialog({
  open,
  roles,
  isPending,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  roles: Role[];
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
      supervisorDashboard: values.supervisorDashboard,
    });
  });

  return (
    <ComposedModal open={open} onClose={onClose} size="sm" preventCloseOnClickOutside>
      <ModalHeader title="Create role" closeModal={onClose} />
      <ModalBody hasScrollingContent>
        <Form id="create-role-form" onSubmit={submit}>
          <Stack gap={6}>
            {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Role not created" subtitle={error.message} />}
            <TextInput
              id="create-role-name"
              labelText="Role name"
              placeholder="e.g. Workshop lead"
              invalid={Boolean(form.formState.errors.name)}
              invalidText={form.formState.errors.name?.message}
              {...form.register('name', { required: 'Enter a role name.', maxLength: { value: 100, message: 'Use at most 100 characters.' } })}
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
            <Select id="copy-role-permissions" labelText="Copy permissions from (optional)" {...form.register('copyFromRoleId')}>
              <SelectItem value="" text="— Start from scratch —" />
              {roles.map((role) => <SelectItem key={role.id} value={role.id} text={role.name} />)}
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
              onChange={(event) => form.setValue('laborordnungMode', event.target.value as Role['laborordnungMode'], { shouldDirty: true })}
            >
              <SelectItem value="not_required" text="Not required" />
              <SelectItem value="warning" text="Warning" />
              <SelectItem value="blocking" text="Block admission" />
            </Select>
            <Checkbox
              id="create-role-supervisor-dashboard"
              labelText="Designate as a supervisor role"
              checked={form.watch('supervisorDashboard')}
              onChange={(_, data) => form.setValue('supervisorDashboard', data.checked, { shouldDirty: true })}
            />
          </Stack>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" type="button" disabled={isPending} onClick={onClose}>Cancel</Button>
        <Button type="submit" form="create-role-form" disabled={isPending}>{isPending ? 'Creating…' : 'Create role'}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}

export function RoleSettingsDialog({
  role,
  isPending,
  error,
  onClose,
  onSubmit,
}: {
  role?: Role;
  isPending: boolean;
  error?: Error | null;
  onClose: () => void;
  onSubmit: (request: UpdateRoleRequest) => void;
}) {
  const form = useForm<RoleForm>({ defaultValues: emptyRoleForm });
  useEffect(() => {
    if (role) form.reset({
      name: role.name,
      description: role.description ?? '',
      copyFromRoleId: '',
      profileImageRequired: role.profileImageRequired,
      laborordnungMode: role.laborordnungMode,
      supervisorDashboard: role.supervisorDashboard,
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
      supervisorDashboard: values.supervisorDashboard,
    });
  });
  return (
    <ComposedModal open={Boolean(role)} onClose={onClose} size="sm" preventCloseOnClickOutside>
      <ModalHeader title="Edit role" closeModal={onClose} />
      <ModalBody hasScrollingContent>
        {role && (
          <Form id="edit-role-form" onSubmit={submit}>
            <Stack gap={6}>
              {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Role not updated" subtitle={error.message} />}
              <TextInput id="edit-role-name" labelText="Role name" invalid={Boolean(form.formState.errors.name)} invalidText={form.formState.errors.name?.message} {...form.register('name', { required: 'Enter a role name.', maxLength: { value: 100, message: 'Use at most 100 characters.' } })} />
              <TextArea id="edit-role-description" labelText="Description (optional)" rows={3} invalid={Boolean(form.formState.errors.description)} invalidText={form.formState.errors.description?.message} {...form.register('description', { maxLength: { value: 500, message: 'Use at most 500 characters.' } })} />
              <Checkbox id="edit-role-profile-image-required" labelText="Require a profile image" checked={form.watch('profileImageRequired')} onChange={(_, data) => form.setValue('profileImageRequired', data.checked, { shouldDirty: true })} />
              <Select id="edit-role-lab-rules" labelText="Lab Rules requirement" value={form.watch('laborordnungMode')} onChange={(event) => form.setValue('laborordnungMode', event.target.value as Role['laborordnungMode'], { shouldDirty: true })}>
                <SelectItem value="not_required" text="Not required" />
                <SelectItem value="warning" text="Warning" />
                <SelectItem value="blocking" text="Block admission" />
              </Select>
              <Checkbox id="edit-role-supervisor-dashboard" labelText="Designate as a supervisor role" checked={form.watch('supervisorDashboard')} onChange={(_, data) => form.setValue('supervisorDashboard', data.checked, { shouldDirty: true })} />
            </Stack>
          </Form>
        )}
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" type="button" disabled={isPending} onClick={onClose}>Cancel</Button>
        <Button type="submit" form="edit-role-form" disabled={isPending}>{isPending ? 'Saving…' : 'Save role'}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}

export function DeleteRoleDialog({
  role,
  isPending,
  error,
  onClose,
  onConfirm,
}: {
  role?: Role;
  isPending: boolean;
  error?: Error | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ComposedModal open={Boolean(role)} danger onClose={onClose} size="sm">
      <ModalHeader title="Delete role?" closeModal={onClose} />
      <ModalBody>
        <Stack gap={5}>
          <p>{role ? `${role.name} will be removed from every account. This cannot be undone.` : ''}</p>
          {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Role not deleted" subtitle={error.message} />}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={isPending} onClick={onClose}>Cancel</Button>
        <Button kind="danger" disabled={isPending} onClick={onConfirm}>{isPending ? 'Deleting…' : 'Delete role'}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}

const emptyRoleForm: RoleForm = {
  name: '',
  description: '',
  copyFromRoleId: '',
  profileImageRequired: false,
  laborordnungMode: 'not_required',
  supervisorDashboard: false,
};
