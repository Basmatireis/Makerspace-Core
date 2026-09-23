import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Dropdown,
  InlineNotification,
  Modal,
  MultiSelect,
  Search,
  Select,
  SelectItem,
  Stack,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
} from '@carbon/react';
import { Add, Checkmark, Filter, Reset, Save, Subtract } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker, useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
  AuthenticationAssurance,
  CreateRoleRequest,
  Permission,
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
import {
  grantCoveredBy,
  hasPermission,
  normalizePermissionGrants,
  permissionGrantsValid,
  PermissionId,
} from '../auth/permissions';
import { PermissionEditor } from './PermissionEditor';
import { PermissionMatrix, type PermissionStateFilter } from './PermissionMatrix';
import { permissionGroupOrder, presentPermission } from './permissionPresentation';
import { CreateRoleDialog, DeleteRoleDialog, RoleSettingsDialog } from './RoleDialogs';
import {
  deviceTypeListOptions,
  effectivePermissionOptions,
  fullRoleCatalogOptions,
  permissionListOptions,
  roleKeys,
} from './queries';

type SelectedCell = { roleId: string; permissionId: string };
type RoleDraft = { baseRole: Role; permissionGrants: PermissionGrant[] };
type PendingDraftAction =
  | { kind: 'cell'; role: Role; permission: Permission }
  | { kind: 'tab'; index: number };

const permissionStateOptions: { id: PermissionStateFilter; label: string }[] = [
  { id: 'all', label: 'All grant states' },
  { id: 'granted', label: 'Unconditional in a shown role' },
  { id: 'conditional', label: 'Conditional in a shown role' },
  { id: 'denied', label: 'Missing from every shown role' },
];

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
  const [groupFilter, setGroupFilter] = useState('all');
  const [stateFilter, setStateFilter] = useState<PermissionStateFilter>('all');
  const [visibleRoleIds, setVisibleRoleIds] = useState<string[] | null>(null);
  const [selectedCell, setSelectedCell] = useState<SelectedCell>();
  const [draft, setDraft] = useState<RoleDraft>();
  const [pendingDraftAction, setPendingDraftAction] = useState<PendingDraftAction>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [deleteRoleId, setDeleteRoleId] = useState<string>();
  const [assurance, setAssurance] = useState<AuthenticationAssurance>(currentUser.authenticationAssurance);
  const [deviceTypeId, setDeviceTypeId] = useState(currentUser.managedDevice?.deviceTypeId ?? '');
  const createOpen = location.pathname.endsWith('/new');
  const settingsRole = roles.find((role) => role.id === routeRoleId);
  const deletingRole = roles.find((role) => role.id === deleteRoleId);
  const isMasterActor = currentUser.account.roles.some((role) => role.systemKey === 'master');
  const canManageRole = (role: Role) => hasPermission(currentUser, PermissionId.rolesmanage) &&
    role.systemKey !== 'master' &&
    (isMasterActor || role.permissionGrants.every((grant) =>
      currentUser.delegablePermissionGrants.some((own) => grantCoveredBy(own, grant))));
  const canManagePermission = (role: Role, permission: Permission) => canManageRole(role) &&
    currentUser.delegablePermissionGrants.some((grant) => grant.permissionId === permission.id);
  const copySources = roles.filter((role) => role.systemKey !== 'master' || isMasterActor)
    .filter((role) => isMasterActor || role.permissionGrants.every((grant) =>
      currentUser.delegablePermissionGrants.some((own) => grantCoveredBy(own, grant))));

  const visibleRoles = useMemo(() => {
    if (visibleRoleIds === null) return roles;
    const selected = new Set(visibleRoleIds);
    return roles.filter((role) => selected.has(role.id));
  }, [roles, visibleRoleIds]);
  const matrixRoles = useMemo(() => visibleRoles.map((role) => role.id === draft?.baseRole.id
    ? { ...role, permissionGrants: draft.permissionGrants }
    : role), [draft, visibleRoles]);
  const changedPermissionIds = useMemo(
    () => draft ? permissionChanges(draft.baseRole.permissionGrants, draft.permissionGrants) : new Set<string>(),
    [draft],
  );
  const draftDirty = changedPermissionIds.size > 0;
  const draftValid = Boolean(draft && permissionGrantsValid(draft.permissionGrants));
  const selectedPermission = permissions.find((permission) => permission.id === selectedCell?.permissionId);
  const selectedRules = draft && selectedPermission
    ? grantsForPermission(draft.permissionGrants, selectedPermission.id)
    : [];
  const groupOptions = useMemo(() => [
    { id: 'all', label: 'All permission groups' },
    ...permissionGroupOrder
      .filter((group) => permissions.some((permission) => presentPermission(permission).group === group))
      .map((group) => ({ id: group, label: group })),
  ], [permissions]);
  const activeFilterCount = Number(search.trim().length > 0) + Number(groupFilter !== 'all') +
    Number(stateFilter !== 'all') + Number(visibleRoleIds !== null);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draftDirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [draftDirty]);
  const blocker = useBlocker(draftDirty);

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
      permissionGrants: normalizePermissionGrants(rules),
    }),
    onSuccess: async () => {
      setReviewOpen(false);
      setSelectedCell(undefined);
      setDraft(undefined);
      await refreshRoles();
    },
  });
  const permissionStale = permissionMutation.error instanceof ApiError && permissionMutation.error.status === 409;

  const activateCell = (role: Role, permission: Permission) => {
    permissionMutation.reset();
    setDraft({
      baseRole: role,
      permissionGrants: normalizePermissionGrants(role.permissionGrants),
    });
    setSelectedCell({ roleId: role.id, permissionId: permission.id });
  };
  const requestCell = (role: Role, permission: Permission) => {
    if (draft && draft.baseRole.id !== role.id && draftDirty) {
      setPendingDraftAction({ kind: 'cell', role, permission });
      return;
    }
    if (draft?.baseRole.id === role.id) {
      permissionMutation.reset();
      setSelectedCell({ roleId: role.id, permissionId: permission.id });
      return;
    }
    activateCell(role, permission);
  };
  const requestTab = (index: number) => {
    if (index === selectedTab) return;
    if (draftDirty) {
      setPendingDraftAction({ kind: 'tab', index });
      return;
    }
    setDraft(undefined);
    setSelectedCell(undefined);
    setSelectedTab(index);
  };
  const discardDraft = () => {
    permissionMutation.reset();
    setReviewOpen(false);
    setSelectedCell(undefined);
    setDraft(undefined);
  };
  const continueAfterDiscard = () => {
    const action = pendingDraftAction;
    setPendingDraftAction(undefined);
    discardDraft();
    if (!action) return;
    if (action.kind === 'cell') activateCell(action.role, action.permission);
    else setSelectedTab(action.index);
  };
  const updateSelectedRules = (rules: PermissionGrant[]) => {
    if (!draft || !selectedPermission) return;
    permissionMutation.reset();
    setDraft({
      ...draft,
      permissionGrants: normalizePermissionGrants([
        ...draft.permissionGrants.filter((grant) => grant.permissionId !== selectedPermission.id),
        ...rules,
      ]),
    });
  };
  const revertSelectedPermission = () => {
    if (!draft || !selectedPermission) return;
    updateSelectedRules(grantsForPermission(draft.baseRole.permissionGrants, selectedPermission.id));
  };
  const resetFilters = () => {
    setSearch('');
    setGroupFilter('all');
    setStateFilter('all');
    setVisibleRoleIds(null);
  };

  const isPending = rolesQuery.isPending || permissionQuery.isPending || deviceTypesQuery.isPending;
  const loadError = rolesQuery.error ?? permissionQuery.error ?? deviceTypesQuery.error;
  if (isPending) return <InlineLoadingState label="Loading roles and permissions" />;
  if (loadError) {
    return <ErrorState title="Unable to load roles and permissions" message="Check the connection and try again." onRetry={() => void Promise.all([rolesQuery.refetch(), permissionQuery.refetch(), deviceTypesQuery.refetch()])} />;
  }

  const reviewChanges = draft ? describePermissionChanges(draft.baseRole.permissionGrants, draft.permissionGrants, permissions) : [];

  return (
    <Stack gap={6} className="roles-page">
      <PageHeader
        title="Roles & Permissions"
        breadcrumbs={[{ label: 'Settings', to: '/settings' }]}
        description="Compare role access, stage permission rules, and evaluate authentication and device constraints."
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
            <div className="roles-toolbar__primary">
              <div className="roles-toolbar__view">
                <Tabs selectedIndex={selectedTab} onChange={({ selectedIndex }) => requestTab(selectedIndex)}>
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
              <Search labelText="Search permissions" placeholder="Search name, identifier, or description" size="md" value={search} onChange={(event) => setSearch(event.currentTarget.value)} />
            </div>
            <div className="roles-filters" aria-label="Permission matrix filters">
              <Dropdown
                id="permission-group-filter"
                titleText="Permission group"
                label="Choose a group"
                items={groupOptions}
                itemToString={(item) => item?.label ?? ''}
                selectedItem={groupOptions.find((item) => item.id === groupFilter)}
                onChange={({ selectedItem }) => setGroupFilter(selectedItem?.id ?? 'all')}
              />
              <Dropdown
                id="permission-state-filter"
                titleText="Grant state"
                label="Choose a grant state"
                items={permissionStateOptions}
                itemToString={(item) => item?.label ?? ''}
                selectedItem={permissionStateOptions.find((item) => item.id === stateFilter)}
                onChange={({ selectedItem }) => setStateFilter(selectedItem?.id ?? 'all')}
              />
              <MultiSelect
                id="visible-role-filter"
                titleText="Roles shown"
                label="Choose roles"
                items={roles}
                itemToString={(role) => role?.name ?? ''}
                selectedItems={visibleRoles}
                onChange={({ selectedItems }) => {
                  const ids = (selectedItems ?? []).map((role) => role.id);
                  setVisibleRoleIds(ids.length === roles.length ? null : ids);
                }}
              />
              <div className="roles-filters__status">
                <Tag type={activeFilterCount > 0 ? 'blue' : 'gray'}>
                  {activeFilterCount} active {activeFilterCount === 1 ? 'filter' : 'filters'}
                </Tag>
                <Button kind="ghost" size="sm" renderIcon={Reset} disabled={activeFilterCount === 0} onClick={resetFilters}>
                  Reset filters
                </Button>
              </div>
            </div>
          </div>
          {selectedTab === 1 && (
            <div className="effective-context" aria-label="Effective permission context">
              <span>Evaluate as:</span>
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
          {draft && selectedTab === 0 && (
            <section className="roles-draft-bar" aria-label="Permission draft">
              <div className="roles-draft-bar__summary">
                <strong>Editing {draft.baseRole.name}</strong>
                <Tag type={draftDirty ? 'blue' : 'gray'}>
                  {changedPermissionIds.size} modified {changedPermissionIds.size === 1 ? 'permission' : 'permissions'}
                </Tag>
                <span>Changes remain local until the complete role is reviewed and saved.</span>
              </div>
              <div className="roles-draft-bar__actions">
                <Button kind="secondary" size="sm" disabled={permissionMutation.isPending} onClick={discardDraft}>
                  {draftDirty ? 'Discard changes' : 'Stop editing'}
                </Button>
                <Button size="sm" renderIcon={Save} disabled={permissionMutation.isPending || !draftDirty || !draftValid} onClick={() => setReviewOpen(true)}>
                  Review and save
                </Button>
              </div>
            </section>
          )}
          {permissionMutation.isError && draft && (
            <div className="roles-draft-error">
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title={permissionStale ? 'Role changed before this draft was saved' : 'Role permissions were not saved'}
                subtitle={`${permissionMutation.error.message} Your local draft is still intact.`}
              />
              {permissionStale && <Button kind="tertiary" size="sm" onClick={() => setReloadConfirmOpen(true)}>Discard draft and reload</Button>}
            </div>
          )}
          {selectedTab === 1 && (effectiveQuery.isPending || evaluationMismatch) && <InlineLoadingState label="Evaluating permissions" />}
          {selectedTab === 1 && effectiveQuery.isError && <ErrorState title="Unable to evaluate permissions" message="Change the context or try again." onRetry={() => void effectiveQuery.refetch()} />}
          {(selectedTab === 0 || effectivePermissions) && (
            <PermissionMatrix
              permissions={permissions}
              roles={matrixRoles}
              deviceTypes={deviceTypes}
              search={search}
              groupFilter={groupFilter}
              stateFilter={stateFilter}
              effectivePermissions={selectedTab === 1 ? effectivePermissions : undefined}
              editingRoleId={draft?.baseRole.id}
              selectedPermissionId={selectedCell?.permissionId}
              changedPermissionIds={changedPermissionIds}
              canManageRole={canManageRole}
              canManagePermission={canManagePermission}
              onSelectCell={requestCell}
              onEditRole={(role) => navigate(`/settings/roles/${role.id}`)}
              onDeleteRole={(role) => setDeleteRoleId(role.id)}
            />
          )}
        </div>
        {selectedTab === 0 && draft && selectedPermission && selectedCell?.roleId === draft.baseRole.id && (
          <PermissionEditor
            key={`${draft.baseRole.id}-${selectedPermission.id}`}
            role={draft.baseRole}
            permission={selectedPermission}
            rules={selectedRules}
            modified={changedPermissionIds.has(selectedPermission.id)}
            allowed={currentUser.delegablePermissionGrants}
            deviceTypes={deviceTypes}
            isSaving={permissionMutation.isPending}
            onChange={updateSelectedRules}
            onRevert={revertSelectedPermission}
            onClose={() => setSelectedCell(undefined)}
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
      {reviewOpen && draft && <Modal
        open
        modalHeading={`Review permission changes for ${draft.baseRole.name}`}
        primaryButtonText={permissionMutation.isPending ? 'Saving…' : 'Save role permissions'}
        secondaryButtonText="Keep editing"
        primaryButtonDisabled={permissionMutation.isPending || !draftDirty || !draftValid}
        onRequestClose={() => setReviewOpen(false)}
        onRequestSubmit={() => {
          if (!draftDirty || !draftValid) return;
          setReviewOpen(false);
          permissionMutation.mutate({ role: draft.baseRole, rules: draft.permissionGrants });
        }}
      >
        <Stack gap={5}>
          <p>This replaces the role’s complete permission configuration in one atomic update.</p>
          <ul className="roles-change-review">
            {reviewChanges.map((change) => (
              <li key={change.permissionId}>
                <Tag type={change.kind === 'added' ? 'green' : change.kind === 'removed' ? 'red' : 'blue'} size="sm">
                  {change.kind}
                </Tag>
                <span>{change.label}</span>
              </li>
            ))}
          </ul>
        </Stack>
      </Modal>}
      {pendingDraftAction && <Modal
        open
        danger
        modalHeading="Discard unsaved permission changes?"
        primaryButtonText="Discard and continue"
        secondaryButtonText="Keep editing"
        onRequestClose={() => setPendingDraftAction(undefined)}
        onRequestSubmit={continueAfterDiscard}
      >
        <p>The staged changes for {draft?.baseRole.name ?? 'this role'} have not been saved.</p>
      </Modal>}
      {blocker.state === 'blocked' && <Modal
        open
        danger
        modalHeading="Leave without saving role changes?"
        primaryButtonText="Discard and leave"
        secondaryButtonText="Stay on this page"
        onRequestClose={() => blocker.reset?.()}
        onRequestSubmit={() => {
          discardDraft();
          blocker.proceed?.();
        }}
      >
        <p>The staged permission changes have not been saved.</p>
      </Modal>}
      {reloadConfirmOpen && <Modal
        open
        danger
        modalHeading="Discard this stale draft?"
        primaryButtonText="Discard and reload"
        secondaryButtonText="Keep draft"
        onRequestClose={() => setReloadConfirmOpen(false)}
        onRequestSubmit={() => {
          setReloadConfirmOpen(false);
          discardDraft();
          void rolesQuery.refetch();
        }}
      >
        <p>Reloading fetches the current server version and permanently discards these local changes.</p>
      </Modal>}
    </Stack>
  );
}

function MatrixLegend({ conditional = false }: { conditional?: boolean }) {
  return (
    <div className="roles-legend" aria-label="Permission state legend">
      <span>Legend:</span>
      <span><Subtract size={16} /> Not granted</span>
      <span className="roles-legend--granted"><Checkmark size={16} /> Unconditional</span>
      {conditional && <span className="roles-legend--conditional"><Checkmark size={16} /><Filter size={12} /> Conditional</span>}
    </div>
  );
}

function grantsForPermission(grants: readonly PermissionGrant[], permissionId: string) {
  return normalizePermissionGrants(grants.filter((grant) => grant.permissionId === permissionId));
}

function permissionChanges(original: readonly PermissionGrant[], next: readonly PermissionGrant[]) {
  const ids = new Set([...original, ...next].map((grant) => grant.permissionId));
  return new Set([...ids].filter((permissionId) => !sameGrants(
    grantsForPermission(original, permissionId),
    grantsForPermission(next, permissionId),
  )));
}

function sameGrants(left: readonly PermissionGrant[], right: readonly PermissionGrant[]) {
  return JSON.stringify(canonicalGrants(left)) === JSON.stringify(canonicalGrants(right));
}

function canonicalGrants(grants: readonly PermissionGrant[]) {
  return normalizePermissionGrants(grants)
    .map((grant) => ({ ...grant, deviceTypeIds: [...grant.deviceTypeIds].sort() }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function describePermissionChanges(
  original: readonly PermissionGrant[],
  next: readonly PermissionGrant[],
  permissions: readonly Permission[],
) {
  const permissionById = new Map(permissions.map((permission) => [permission.id, permission]));
  return [...permissionChanges(original, next)].map((permissionId) => {
    const before = grantsForPermission(original, permissionId);
    const after = grantsForPermission(next, permissionId);
    const permission = permissionById.get(permissionId as Permission['id']);
    return {
      permissionId,
      label: permission ? presentPermission(permission).label : permissionId,
      kind: before.length === 0 ? 'added' : after.length === 0 ? 'removed' : 'changed',
    } as const;
  }).sort((left, right) => left.label.localeCompare(right.label));
}
