import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  InlineNotification,
  Search,
  Select,
  SelectItem,
  Stack,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
} from '@carbon/react';
import { Add, Checkmark, Filter, Subtract } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
  AuthenticationAssurance,
  CreateRoleRequest,
  PermissionGrant,
  Role,
  UpdateRoleRequest,
} from '../../api/generated/models';
import {
  createRole,
  deleteRole,
  replaceRolePermissions,
  updateRole,
} from '../../api/generated/roles/roles';
import { ApiError } from '../../api/http-client';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { authQueryKey, useCurrentUser } from '../auth/auth';
import { grantCoveredBy, hasPermission, normalizePermissionGrants, PermissionId } from '../auth/permissions';
import { PermissionEditor } from './PermissionEditor';
import { PermissionMatrix } from './PermissionMatrix';
import { CreateRoleDialog, DeleteRoleDialog, RoleSettingsDialog } from './RoleDialogs';
import {
  deviceTypeListOptions,
  effectivePermissionOptions,
  fullRoleCatalogOptions,
  permissionListOptions,
  roleKeys,
} from './queries';

type SelectedCell = { roleId: string; permissionId: string };

export function RolesPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const location = useLocation();
  const { roleId: routeRoleId } = useParams();
  const queryClient = useQueryClient();
  const rolesQuery = useQuery(fullRoleCatalogOptions);
  const permissionQuery = useQuery(permissionListOptions);
  const deviceTypesQuery = useQuery(deviceTypeListOptions);
  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const permissions = useMemo(() => permissionQuery.data?.items ?? [], [permissionQuery.data]);
  const deviceTypes = useMemo(() => deviceTypesQuery.data?.items ?? [], [deviceTypesQuery.data]);
  const [selectedTab, setSelectedTab] = useState(0);
  const [search, setSearch] = useState('');
  const [selectedCell, setSelectedCell] = useState<SelectedCell>();
  const [deleteRoleId, setDeleteRoleId] = useState<string>();
  const [assurance, setAssurance] = useState<AuthenticationAssurance>(currentUser.authenticationAssurance);
  const [deviceTypeId, setDeviceTypeId] = useState(currentUser.managedDevice?.deviceTypeId ?? '');
  const createOpen = location.pathname.endsWith('/new');
  const settingsRole = roles.find((role) => role.id === routeRoleId);
  const deletingRole = roles.find((role) => role.id === deleteRoleId);
  const selectedRole = roles.find((role) => role.id === selectedCell?.roleId);
  const selectedPermission = permissions.find((permission) => permission.id === selectedCell?.permissionId);
  const isMasterActor = currentUser.account.roles.some((role) => role.systemKey === 'master');
  const canManageRole = (role: Role) => hasPermission(currentUser, PermissionId.rolesmanage) &&
    role.systemKey !== 'master' &&
    (isMasterActor || role.permissionGrants.every((grant) =>
      currentUser.delegablePermissionGrants.some((own) => grantCoveredBy(own, grant))));
  const copySources = roles.filter((role) => role.systemKey !== 'master' || isMasterActor)
    .filter((role) => isMasterActor || role.permissionGrants.every((grant) =>
      currentUser.delegablePermissionGrants.some((own) => grantCoveredBy(own, grant))));

  const effectiveQuery = useQuery({
    ...effectivePermissionOptions(assurance, deviceTypeId || undefined),
    enabled: selectedTab === 1,
  });
  const evaluationMismatch = useMemo(() => effectiveQuery.data?.items.some((evaluation) => {
    const role = roles.find((candidate) => candidate.id === evaluation.roleId);
    return !role || role.version !== evaluation.roleVersion;
  }) ?? false, [effectiveQuery.data, roles]);
  const refetchRoles = rolesQuery.refetch;
  const refetchEffectivePermissions = effectiveQuery.refetch;
  useEffect(() => {
    if (evaluationMismatch) void Promise.all([refetchRoles(), refetchEffectivePermissions()]);
  }, [evaluationMismatch, refetchEffectivePermissions, refetchRoles]);
  const effectivePermissions = useMemo(() => {
    if (!effectiveQuery.data || evaluationMismatch) return undefined;
    return new Map(effectiveQuery.data.items.map((evaluation) => [
      evaluation.roleId,
      new Set(evaluation.permissionIds),
    ]));
  }, [effectiveQuery.data, evaluationMismatch]);

  const refreshRoles = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: roleKeys.all }),
      queryClient.invalidateQueries({ queryKey: authQueryKey }),
    ]);
  };
  const createMutation = useMutation({
    mutationFn: (request: CreateRoleRequest) => createRole(request),
    onSuccess: async () => {
      await refreshRoles();
      navigate('/settings/roles', { replace: true });
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, request }: { id: string; request: UpdateRoleRequest }) => updateRole(id, request),
    onSuccess: async () => {
      await refreshRoles();
      navigate('/settings/roles', { replace: true });
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (role: Role) => deleteRole(role.id, { expectedVersion: role.version }),
    onSuccess: async () => {
      setDeleteRoleId(undefined);
      await refreshRoles();
      navigate('/settings/roles', { replace: true });
    },
  });
  const permissionMutation = useMutation({
    mutationFn: ({ role, rules }: { role: Role; rules: PermissionGrant[] }) => replaceRolePermissions(role.id, {
      expectedVersion: role.version,
      permissionGrants: normalizePermissionGrants([
        ...role.permissionGrants.filter((grant) => grant.permissionId !== selectedCell?.permissionId),
        ...rules,
      ]),
    }),
    onSuccess: async () => {
      setSelectedCell(undefined);
      await refreshRoles();
    },
  });
  const permissionStale = permissionMutation.error instanceof ApiError && permissionMutation.error.status === 409;

  const isPending = rolesQuery.isPending || permissionQuery.isPending || deviceTypesQuery.isPending;
  const loadError = rolesQuery.error ?? permissionQuery.error ?? deviceTypesQuery.error;
  if (isPending) return <InlineLoadingState label="Loading roles and permissions" />;
  if (loadError) {
    return <ErrorState title="Unable to load roles and permissions" message="Check the connection and try again." onRetry={() => void Promise.all([rolesQuery.refetch(), permissionQuery.refetch(), deviceTypesQuery.refetch()])} />;
  }

  return (
    <Stack gap={6} className="roles-page">
      <PageHeader
        title="Roles & Permissions"
        breadcrumbs={[{ label: 'Settings', to: '/settings' }]}
        description="Configure what each role can do and under which conditions."
        actions={hasPermission(currentUser, PermissionId.rolesmanage)
          ? <Button kind="tertiary" renderIcon={Add} onClick={() => navigate('/settings/roles/new')}>Create role</Button>
          : undefined}
      />
      {routeRoleId && !settingsRole && rolesQuery.data && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Role not found" subtitle="The role may have been deleted." />
      )}
      <div className={`roles-workspace${selectedCell ? ' roles-workspace--panel-open' : ''}`}>
        <div className="roles-workspace__main">
          <div className="roles-toolbar">
            <div className="roles-toolbar__view">
              <Tabs selectedIndex={selectedTab} onChange={({ selectedIndex }) => {
                setSelectedTab(selectedIndex);
                setSelectedCell(undefined);
              }}>
                <TabList aria-label="Permission matrix view">
                  <Tab>Configuration</Tab>
                  <Tab>Effective permissions</Tab>
                </TabList>
                <TabPanels>
                  <TabPanel><MatrixLegend conditional /></TabPanel>
                  <TabPanel><MatrixLegend /></TabPanel>
                </TabPanels>
              </Tabs>
            </div>
            <Search labelText="Search permissions" placeholder="Search permissions" size="md" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
          </div>
          {selectedTab === 1 && (
            <div className="effective-context" aria-label="Effective permission context">
              <span>Viewing as:</span>
              <Select id="effective-assurance" hideLabel labelText="Authentication assurance" value={assurance} onChange={(event) => setAssurance(event.target.value as AuthenticationAssurance)}>
                <SelectItem value="low" text="Low assurance" />
                <SelectItem value="normal" text="Normal assurance" />
                <SelectItem value="strong" text="Strong assurance" />
                <SelectItem value="strong_mfa" text="Strong + MFA" />
              </Select>
              <Select id="effective-device" hideLabel labelText="Device context" value={deviceTypeId} onChange={(event) => setDeviceTypeId(event.target.value)}>
                <SelectItem value="" text="Unmanaged device" />
                {deviceTypes.map((type) => <SelectItem key={type.id} value={type.id} text={type.name} />)}
              </Select>
            </div>
          )}
          {selectedTab === 1 && (effectiveQuery.isPending || evaluationMismatch) && <InlineLoadingState label="Evaluating permissions" />}
          {selectedTab === 1 && effectiveQuery.isError && <ErrorState title="Unable to evaluate permissions" message="Change the context or try again." onRetry={() => void effectiveQuery.refetch()} />}
          {(selectedTab === 0 || effectivePermissions) && (
            <PermissionMatrix
              permissions={permissions}
              roles={roles}
              deviceTypes={deviceTypes}
              search={search}
              effectivePermissions={selectedTab === 1 ? effectivePermissions : undefined}
              canManageRole={canManageRole}
              onSelectCell={(role, permission) => {
                permissionMutation.reset();
                setSelectedCell({ roleId: role.id, permissionId: permission.id });
              }}
              onEditRole={(role) => navigate(`/settings/roles/${role.id}`)}
              onDeleteRole={(role) => setDeleteRoleId(role.id)}
            />
          )}
        </div>
        {selectedTab === 0 && selectedRole && selectedPermission && (
          <PermissionEditor
            key={`${selectedRole.id}-${selectedRole.version}-${selectedPermission.id}`}
            role={selectedRole}
            permission={selectedPermission}
            allowed={currentUser.delegablePermissionGrants}
            deviceTypes={deviceTypes}
            isSaving={permissionMutation.isPending}
            error={permissionMutation.error}
            stale={permissionStale}
            onSave={(rules) => permissionMutation.mutate({ role: selectedRole, rules })}
            onReload={() => {
              permissionMutation.reset();
              void rolesQuery.refetch();
            }}
            onClose={() => {
              permissionMutation.reset();
              setSelectedCell(undefined);
            }}
          />
        )}
      </div>
      <CreateRoleDialog
        open={createOpen}
        roles={copySources}
        isPending={createMutation.isPending}
        error={createMutation.error}
        onClose={() => navigate('/settings/roles', { replace: true })}
        onSubmit={(request) => createMutation.mutate(request)}
      />
      <RoleSettingsDialog
        role={settingsRole && canManageRole(settingsRole) ? settingsRole : undefined}
        isPending={updateMutation.isPending}
        error={updateMutation.error}
        onClose={() => navigate('/settings/roles', { replace: true })}
        onSubmit={(request) => settingsRole && updateMutation.mutate({ id: settingsRole.id, request })}
      />
      <DeleteRoleDialog
        role={deletingRole}
        isPending={deleteMutation.isPending}
        error={deleteMutation.error}
        onClose={() => setDeleteRoleId(undefined)}
        onConfirm={() => deletingRole && deleteMutation.mutate(deletingRole)}
      />
    </Stack>
  );
}

function MatrixLegend({ conditional = false }: { conditional?: boolean }) {
  return (
    <div className="roles-legend" aria-label="Permission state legend">
      <span>Legend:</span>
      <span><Subtract size={16} /> Not granted</span>
      <span className="roles-legend--granted"><Checkmark size={16} /> Granted</span>
      {conditional && <span className="roles-legend--conditional"><Checkmark size={16} /><Filter size={12} /> Conditional grant</span>}
    </div>
  );
}
