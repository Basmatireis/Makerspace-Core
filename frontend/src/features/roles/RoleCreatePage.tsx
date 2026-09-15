import { Button, Form, InlineNotification, Stack, TextArea, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import type { PermissionGrant } from '../../api/generated/models';
import { createRole } from '../../api/generated/roles/roles';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { permissionGrantsValid } from '../auth/permissions';
import { PermissionChecklist } from './PermissionChecklist';
import { deviceTypeListOptions, permissionListOptions, roleKeys } from './queries';

type RoleForm = { name: string; description: string };

export function RoleCreatePage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissionQuery = useQuery(permissionListOptions);
  const [permissionGrants, setPermissionGrants] = useState<PermissionGrant[]>([]);
  const deviceTypesQuery = useQuery(deviceTypeListOptions);
  const form = useForm<RoleForm>({ defaultValues: { name: '', description: '' } });
  const createMutation = useMutation({
    mutationFn: ({ name, description }: RoleForm) => createRole({
      name: name.trim(),
      description: description.trim() || null,
      permissionGrants,
    }),
    onSuccess: async (role) => {
      await queryClient.invalidateQueries({ queryKey: roleKeys.lists() });
      navigate(`/settings/roles/${role.id}`, { replace: true });
    },
  });
  const onSubmit = form.handleSubmit(async (values) => {
    try { await createMutation.mutateAsync(values); } catch { /* rendered below */ }
  });

  return (
    <Stack gap={7}>
      <PageHeader title="Create role" breadcrumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Roles', to: '/settings/roles' }]} description="Create a reusable permission set." />
      {permissionQuery.isPending && <InlineLoadingState label="Loading permissions" />}
      {permissionQuery.isError && <ErrorState title="Unable to load permissions" message="Permission definitions are required to create a role." onRetry={() => void permissionQuery.refetch()} />}
      {permissionQuery.data && (
        <Tile className="form-tile">
          <Form onSubmit={onSubmit}>
            <Stack gap={7}>
              {createMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Role not created" subtitle="Review the values and try again." />}
              <TextInput id="role-name" labelText="Role name" invalid={Boolean(form.formState.errors.name)} invalidText={form.formState.errors.name?.message} {...form.register('name', { required: 'Enter a role name.', maxLength: { value: 100, message: 'Use at most 100 characters.' } })} />
              <TextArea id="role-description" labelText="Description" rows={3} invalid={Boolean(form.formState.errors.description)} invalidText={form.formState.errors.description?.message} {...form.register('description', { maxLength: { value: 500, message: 'Use at most 500 characters.' } })} />
              <div><h2>Permissions</h2><p className="section-description">You can grant only permissions you currently hold.</p></div>
              <PermissionChecklist permissions={permissionQuery.data.items} grants={permissionGrants} allowed={currentUser.delegablePermissionGrants} deviceTypes={deviceTypesQuery.data?.items ?? []} onChange={setPermissionGrants} />
              <div className="form-actions"><Button kind="secondary" type="button" onClick={() => navigate('/settings/roles')}>Cancel</Button><Button type="submit" disabled={createMutation.isPending || !permissionGrantsValid(permissionGrants)}>{createMutation.isPending ? 'Creating…' : 'Create role'}</Button></div>
            </Stack>
          </Form>
        </Tile>
      )}
    </Stack>
  );
}
