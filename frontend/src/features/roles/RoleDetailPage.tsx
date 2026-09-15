import { useEffect, useRef, useState } from 'react';
import {
  Button,
  ComposedModal,
  Form,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  Tag,
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react';
import { TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router-dom';
import type { PermissionGrant, Role, UpdateRoleRequest } from '../../api/generated/models';
import { deleteRole, replaceRolePermissions, updateRole } from '../../api/generated/roles/roles';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, FullPageLoading, InlineLoadingState } from '../../app/PageState';
import { authQueryKey, useCurrentUser } from '../auth/auth';
import { grantCoveredBy, hasPermission, permissionGrantsValid, PermissionId as PermissionIds } from '../auth/permissions';
import { PermissionChecklist } from './PermissionChecklist';
import { deviceTypeListOptions, permissionListOptions, roleKeys, roleOptions } from './queries';

type RoleMetadataForm = { name: string; description: string };

export function RoleDetailPage() {
  const { roleId = '' } = useParams();
  const roleQuery = useQuery(roleOptions(roleId));
  if (roleQuery.isPending) return <FullPageLoading label="Loading role" />;
  if (roleQuery.isError || !roleQuery.data) return <ErrorState title="Unable to load role" message="The role may no longer exist or you may not have access." onRetry={() => void roleQuery.refetch()} />;
  return <RoleDetailContent key={`${roleQuery.data.id}-${roleQuery.data.version}`} role={roleQuery.data} />;
}

function RoleDetailContent({ role }: { role: Role }) {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissionQuery = useQuery(permissionListOptions);
  const isMasterActor = currentUser.account.roles.some((assignedRole) => assignedRole.systemKey === 'master');
  const roleIsSubset = role.permissionGrants.every((grant) =>
    currentUser.delegablePermissionGrants.some((own) => grantCoveredBy(own, grant)),
  );
  const canManage = hasPermission(currentUser, PermissionIds.rolesmanage) &&
    role.systemKey !== 'master' &&
    (isMasterActor || roleIsSubset);
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [editingPermissions, setEditingPermissions] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const [permissionGrants, setPermissionGrants] = useState<PermissionGrant[]>(role.permissionGrants);
  const deviceTypesQuery = useQuery(deviceTypeListOptions);
  const form = useForm<RoleMetadataForm>({ defaultValues: { name: role.name, description: role.description ?? '' } });

  useEffect(() => setPermissionGrants(role.permissionGrants), [role.permissionGrants]);
  const updateMutation = useMutation({
    mutationFn: (request: UpdateRoleRequest) => updateRole(role.id, request),
    onSuccess: async (updated) => {
      queryClient.setQueryData(roleKeys.detail(role.id), updated);
      setEditingMetadata(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: roleKeys.lists() }),
        queryClient.invalidateQueries({ queryKey: authQueryKey }),
      ]);
    },
  });
  const permissionMutation = useMutation({
    mutationFn: () => replaceRolePermissions(role.id, { permissionGrants, expectedVersion: role.version }),
    onSuccess: async (updated) => {
      queryClient.setQueryData(roleKeys.detail(role.id), updated);
      setEditingPermissions(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: roleKeys.lists() }),
        queryClient.invalidateQueries({ queryKey: authQueryKey }),
      ]);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteRole(role.id, { expectedVersion: role.version }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: roleKeys.detail(role.id) });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: roleKeys.lists() }),
        queryClient.invalidateQueries({ queryKey: authQueryKey }),
      ]);
      navigate('/settings/roles', { replace: true });
    },
  });

  const submitMetadata = form.handleSubmit(async (values) => {
    const request: UpdateRoleRequest = { expectedVersion: role.version };
    if (form.formState.dirtyFields.name) request.name = values.name.trim();
    if (form.formState.dirtyFields.description) request.description = values.description.trim() || null;
    try { await updateMutation.mutateAsync(request); } catch { /* rendered below */ }
  });

  return (
    <Stack gap={7}>
      <PageHeader
        title={role.name}
        breadcrumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Roles', to: '/settings/roles' }]}
        description={role.systemKey === 'master' ? 'Protected system role with every application permission.' : 'Role metadata and permissions.'}
        actions={canManage ? <Button ref={deleteButtonRef} kind="danger--tertiary" renderIcon={TrashCan} onClick={() => setDeleteOpen(true)}>Delete role</Button> : undefined}
      />
      {(updateMutation.isError || permissionMutation.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Change not completed" subtitle="The role may have changed. Reload it and try again." />}
      <Tile>
        <Stack gap={6}>
          <div className="section-heading"><div><h2>Role details</h2>{role.systemKey === 'master' && <Tag type="purple">System role</Tag>}</div>{canManage && !editingMetadata && <Button kind="ghost" size="sm" onClick={() => setEditingMetadata(true)}>Edit</Button>}</div>
          {editingMetadata ? (
            <Form onSubmit={submitMetadata}><Stack gap={5}>
              <TextInput id="edit-role-name" labelText="Role name" invalid={Boolean(form.formState.errors.name)} invalidText={form.formState.errors.name?.message} {...form.register('name', { required: 'Enter a role name.', maxLength: { value: 100, message: 'Use at most 100 characters.' } })} />
              <TextArea id="edit-role-description" labelText="Description" rows={3} invalid={Boolean(form.formState.errors.description)} invalidText={form.formState.errors.description?.message} {...form.register('description', { maxLength: { value: 500, message: 'Use at most 500 characters.' } })} />
              <div className="form-actions"><Button kind="secondary" type="button" onClick={() => { form.reset(); setEditingMetadata(false); }}>Cancel</Button><Button type="submit" disabled={!form.formState.isDirty || updateMutation.isPending}>Save</Button></div>
            </Stack></Form>
          ) : <div><p>{role.description || 'No description provided.'}</p></div>}
        </Stack>
      </Tile>
      <Tile>
        <Stack gap={6}>
          <div className="section-heading"><div><h2>Permissions</h2><p className="section-description">{role.permissionGrants.length} assigned</p></div>{canManage && !editingPermissions && <Button kind="ghost" size="sm" onClick={() => setEditingPermissions(true)}>Edit</Button>}</div>
          {permissionQuery.isPending && <InlineLoadingState label="Loading permissions" />}
          {permissionQuery.isError && <ErrorState message="Unable to load permission definitions." onRetry={() => void permissionQuery.refetch()} />}
          {permissionQuery.data && <PermissionChecklist permissions={permissionQuery.data.items} grants={editingPermissions ? permissionGrants : role.permissionGrants} allowed={currentUser.delegablePermissionGrants} deviceTypes={deviceTypesQuery.data?.items ?? []} disabled={!editingPermissions} onChange={setPermissionGrants} />}
          {editingPermissions && <div className="form-actions"><Button kind="secondary" onClick={() => { setPermissionGrants(role.permissionGrants); setEditingPermissions(false); }}>Cancel</Button><Button disabled={permissionMutation.isPending || !permissionGrantsValid(permissionGrants)} onClick={() => permissionMutation.mutate()}>Save permissions</Button></div>}
        </Stack>
      </Tile>
      <ComposedModal open={deleteOpen} danger launcherButtonRef={deleteButtonRef} onClose={() => setDeleteOpen(false)}>
        <ModalHeader title="Delete this role?" />
        <ModalBody><p>The role will be removed from every account. This cannot be undone.</p>{deleteMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Role not deleted" subtitle="Reload the role and try again." />}</ModalBody>
        <ModalFooter><Button kind="secondary" onClick={() => setDeleteOpen(false)}>Cancel</Button><Button kind="danger" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>Delete role</Button></ModalFooter>
      </ComposedModal>
    </Stack>
  );
}
