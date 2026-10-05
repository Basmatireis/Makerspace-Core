import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  InlineNotification,
  Modal,
  OverflowMenu,
  OverflowMenuItem,
  Stack,
  Tag,
  TableToolbarSearch,
} from '@carbon/react';
import { Add, Filter, Locked, Save, UserRole } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker, useLocation, useNavigate, useParams } from 'react-router-dom';
import type {
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
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { authQueryKey, useCurrentUser } from '../auth/auth';
import {
  grantCoveredBy,
  hasPermission,
  normalizePermissionGrants,
  permissionGrantCoveredBy,
  permissionGrantsValid,
  PermissionId,
} from '../auth/permissions';
import { PermissionEditor } from './PermissionEditor';
import { PermissionMatrix } from './PermissionMatrix';
import { permissionGroupOrder, presentPermission } from './permissionPresentation';
import { CreateRoleDialog, DeleteRoleDialog, RoleSettingsDialog } from './RoleDialogs';
import {
  deviceTypeListOptions,
  fullRoleCatalogOptions,
  permissionListOptions,
  roleKeys,
} from './queries';

type SelectedCell = { roleId: string; permissionId: string };
type RoleDraft = { baseRole: Role; permissionGrants: PermissionGrant[] };
type PendingDraftAction =
  | { kind: 'cell'; role: Role; permission: Permission }
  | { kind: 'role'; role: Role };

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
  const [selectedRoleId, setSelectedRoleId] = useState<string>();
  const [selectedCell, setSelectedCell] = useState<SelectedCell>();
  const [draft, setDraft] = useState<RoleDraft>();
  const [pendingDraftAction, setPendingDraftAction] = useState<PendingDraftAction>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reloadConfirmOpen, setReloadConfirmOpen] = useState(false);
  const [deleteRoleId, setDeleteRoleId] = useState<string>();
  const [permissionSearch, setPermissionSearch] = useState('');
  const [permissionGroup, setPermissionGroup] = useState<string>();
  const createOpen = location.pathname.endsWith('/new');
  const settingsRole = roles.find((role) => role.id === routeRoleId);
  const deletingRole = roles.find((role) => role.id === deleteRoleId);
  const isMasterActor = currentUser.person.roles.some((role) => role.systemKey === 'master');
  const canManageRole = (role: Role) => hasPermission(currentUser, PermissionId.rolesmanage) &&
    role.systemKey !== 'master' &&
    (isMasterActor || role.permissionGrants.every((grant) =>
      currentUser.delegablePermissionGrants.some((own) => grantCoveredBy(own, grant))));
  const canManagePermission = (role: Role, permission: Permission) => canManageRole(role) &&
    currentUser.delegablePermissionGrants.some((grant) => grant.permissionId === permission.id);
  const canSetPermissionState = (
    _role: Role,
    permission: Permission,
    state: 'denied' | 'granted' | 'conditional',
  ) => state === 'denied' || (state === 'granted'
    ? permissionGrantCoveredBy(currentUser.delegablePermissionGrants, {
      permissionId: permission.id,
      scope: 'everywhere',
      deviceTypeIds: [],
      minimumAssurance: 'low',
    })
    : currentUser.delegablePermissionGrants.some((grant) => grant.permissionId === permission.id));
  const copySources = roles.filter((role) => role.systemKey !== 'master' || isMasterActor)
    .filter((role) => isMasterActor || role.permissionGrants.every((grant) =>
      currentUser.delegablePermissionGrants.some((own) => grantCoveredBy(own, grant))));
  const availablePermissionGroups = useMemo(() => permissionGroupOrder.filter((group) =>
    permissions.some((permission) => presentPermission(permission).group === group)), [permissions]);
  const visiblePermissions = useMemo(() => {
    const query = permissionSearch.trim().toLocaleLowerCase();
    return permissions.filter((permission) => {
      const presented = presentPermission(permission);
      if (permissionGroup && presented.group !== permissionGroup) return false;
      return !query || `${presented.label} ${permission.id} ${permission.description}`.toLocaleLowerCase().includes(query);
    });
  }, [permissionGroup, permissionSearch, permissions]);

  useEffect(() => {
    if (!selectedRoleId && roles[0]) setSelectedRoleId(roles[0].id);
    else if (selectedRoleId && !roles.some((role) => role.id === selectedRoleId)) setSelectedRoleId(roles[0]?.id);
  }, [roles, selectedRoleId]);
  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? roles[0];
  const matrixRoles = useMemo(() => selectedRole ? [{
    ...selectedRole,
    permissionGrants: selectedRole.id === draft?.baseRole.id ? draft.permissionGrants : selectedRole.permissionGrants,
  }] : [], [draft, selectedRole]);
  const changedPermissionIds = useMemo(
    () => draft ? permissionChanges(draft.baseRole.permissionGrants, draft.permissionGrants) : new Set<string>(),
    [draft],
  );
  const draftDirty = changedPermissionIds.size > 0;
  const draftValid = Boolean(draft && permissionGrantsValid(draft.permissionGrants));
  const selectedPermission = permissions.find((permission) => permission.id === selectedCell?.permissionId);
  const selectedPanelRole = roles.find((role) => role.id === selectedCell?.roleId);
  const selectedRules = selectedPermission && selectedPanelRole
    ? grantsForPermission(
      draft?.baseRole.id === selectedPanelRole.id ? draft.permissionGrants : selectedPanelRole.permissionGrants,
      selectedPermission.id,
    )
    : [];
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (draftDirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [draftDirty]);
  const blocker = useBlocker(draftDirty);

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
    if (!canManagePermission(role, permission)) {
      permissionMutation.reset();
      setSelectedCell({ roleId: role.id, permissionId: permission.id });
      return;
    }
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
  const requestRole = (role: Role) => {
    if (role.id === selectedRole?.id) return;
    if (draftDirty) {
      setPendingDraftAction({ kind: 'role', role });
      return;
    }
    setDraft(undefined);
    setSelectedCell(undefined);
    setSelectedRoleId(role.id);
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
    else setSelectedRoleId(action.role.id);
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
  const setPermissionState = (
    role: Role,
    permission: Permission,
    state: 'denied' | 'granted' | 'conditional',
  ) => {
    const continuingDraft = draft?.baseRole.id === role.id;
    const current = continuingDraft ? draft.permissionGrants : role.permissionGrants;
    const existing = grantsForPermission(current, permission.id);
    let rules: PermissionGrant[] = [];
    if (state === 'granted') {
      rules = [{ permissionId: permission.id, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' }];
    } else if (state === 'conditional') {
      const conditional = existing.filter((grant) => grant.scope !== 'everywhere' || grant.minimumAssurance !== 'low');
      if (conditional.length > 0) rules = conditional;
      else {
        const envelope = currentUser.delegablePermissionGrants.find((grant) => grant.permissionId === permission.id);
        if (envelope) rules = [{
          permissionId: permission.id,
          scope: envelope.scope,
          deviceTypeIds: [...envelope.deviceTypeIds],
          minimumAssurance: envelope.scope === 'everywhere' && envelope.minimumAssurance === 'low'
            ? 'normal'
            : envelope.minimumAssurance,
        }];
      }
    }
    setDraft({
      baseRole: continuingDraft ? draft.baseRole : role,
      permissionGrants: normalizePermissionGrants([
        ...current.filter((grant) => grant.permissionId !== permission.id),
        ...rules,
      ]),
    });
    setSelectedCell({ roleId: role.id, permissionId: permission.id });
    permissionMutation.reset();
  };
  const revertSelectedPermission = () => {
    if (!draft || !selectedPermission) return;
    updateSelectedRules(grantsForPermission(draft.baseRole.permissionGrants, selectedPermission.id));
  };
  const isPending = rolesQuery.isPending || permissionQuery.isPending || deviceTypesQuery.isPending;
  const loadError = rolesQuery.error ?? permissionQuery.error ?? deviceTypesQuery.error;
  if (isPending) return <InlineLoadingState label="Loading roles and permissions" />;
  if (loadError) {
    return <ErrorState title="Unable to load roles and permissions" message="Check the connection and try again." onRetry={() => void Promise.all([rolesQuery.refetch(), permissionQuery.refetch(), deviceTypesQuery.refetch()])} />;
  }

  const reviewChanges = draft ? describePermissionChanges(draft.baseRole.permissionGrants, draft.permissionGrants, permissions) : [];

  return (
    <PageShell
      title="Roles & Permissions"
      breadcrumbs={[{ label: 'Settings', to: '/settings' }]}
      description="Manage role access and stage permission rules. Changes apply to all users with the respective role."
      width="fluid"
      className="roles-page"
    >
      {routeRoleId && !settingsRole && rolesQuery.data && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Role not found" subtitle="The role may have been deleted." />
      )}
      <div className="roles-workspace roles-workspace--panel-open">
        <div className="roles-toolbar" role="toolbar" aria-label="Roles and permissions actions">
          <div className="roles-toolbar__search-slot">
            <TableToolbarSearch
              id="role-permission-search"
              className="roles-toolbar__search"
              size="lg"
              labelText="Search permissions"
              placeholder="Search permissions"
              value={permissionSearch}
              onChange={(_event, value) => setPermissionSearch(value ?? '')}
              onClear={() => setPermissionSearch('')}
            />
          </div>
          <OverflowMenu
            className={`roles-toolbar__filter${permissionGroup ? ' roles-toolbar__filter--active' : ''}`}
            renderIcon={Filter}
            iconDescription="Filter permissions"
            size="lg"
            flipped
          >
            <OverflowMenuItem itemText="All permission groups" onClick={() => setPermissionGroup(undefined)} />
            {availablePermissionGroups.map((group) => (
              <OverflowMenuItem key={group} itemText={group} onClick={() => setPermissionGroup(group)} />
            ))}
          </OverflowMenu>
          {draft && draftDirty && (
            <>
              <Button kind="tertiary" size="sm" disabled={permissionMutation.isPending} onClick={discardDraft}>Discard changes</Button>
              <Button size="sm" renderIcon={Save} disabled={permissionMutation.isPending || !draftValid} onClick={() => setReviewOpen(true)}>
                Review and save
              </Button>
            </>
          )}
          {hasPermission(currentUser, PermissionId.rolesmanage) && (
            <Button className="roles-toolbar__create" kind="primary" size="sm" renderIcon={Add} onClick={() => navigate('/settings/roles/new')}>
              Create role
            </Button>
          )}
        </div>
        <aside className="roles-list" aria-label="Roles">
          <div className="roles-list__items">
            {roles.map((role) => {
              const manageable = canManageRole(role);
              return (
                <div key={role.id} className={`roles-list__item${role.id === selectedRole?.id ? ' roles-list__item--selected' : ''}`}>
                  <button
                    type="button"
                    className="roles-list__select"
                    aria-current={role.id === selectedRole?.id ? 'true' : undefined}
                    onClick={() => requestRole(role)}
                  >
                    <span className="roles-list__icon">{role.systemKey === 'master' ? <Locked size={24} aria-label="Protected system role" /> : <UserRole size={24} aria-hidden="true" />}</span>
                    <span className="roles-list__copy">
                      <strong>{role.name}</strong>
                      <span>{role.description || 'No description'}</span>
                    </span>
                  </button>
                  <OverflowMenu iconDescription={`Actions for ${role.name}`} align="left" size="sm" flipped>
                    {manageable && <OverflowMenuItem itemText="Edit role details" onClick={() => navigate(`/settings/roles/${role.id}`)} />}
                    {manageable && <OverflowMenuItem isDelete itemText="Delete role" onClick={() => setDeleteRoleId(role.id)} />}
                    {!manageable && <OverflowMenuItem disabled itemText="Protected system role" />}
                  </OverflowMenu>
                </div>
              );
            })}
          </div>
        </aside>
        <div className="roles-workspace__main">
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
          <PermissionMatrix
              permissions={visiblePermissions}
              roles={matrixRoles}
              deviceTypes={deviceTypes}
              editingRoleId={draft?.baseRole.id}
              selectedPermissionId={selectedCell?.permissionId}
              changedPermissionIds={changedPermissionIds}
              canManagePermission={canManagePermission}
              canSetState={canSetPermissionState}
              onSelectCell={requestCell}
              onChangeState={setPermissionState}
          />
        </div>
        {selectedPanelRole && selectedPermission ? (
          <PermissionEditor
            key={`${selectedPanelRole.id}-${selectedPermission.id}`}
            permission={selectedPermission}
            rules={selectedRules}
            modified={changedPermissionIds.has(selectedPermission.id)}
            readOnly={!canManagePermission(selectedPanelRole, selectedPermission)}
            allowed={currentUser.delegablePermissionGrants}
            deviceTypes={deviceTypes}
            isSaving={permissionMutation.isPending}
            onChange={updateSelectedRules}
            onRevert={revertSelectedPermission}
            onClose={() => setSelectedCell(undefined)}
          />
        ) : (
          <aside className="permission-editor permission-editor--empty" aria-label="Permission details">
            <div>
              <UserRole size={32} aria-hidden="true" />
              <h2>Select a permission</h2>
              <p>Choose a permission row to view or edit its access rules.</p>
            </div>
          </aside>
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
    </PageShell>
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
