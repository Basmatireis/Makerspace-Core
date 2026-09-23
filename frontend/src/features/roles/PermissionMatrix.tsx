import { useMemo, useState, type CSSProperties } from 'react';
import {
  OverflowMenu,
  OverflowMenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Tooltip,
} from '@carbon/react';
import {
  Checkmark,
  ChevronDown,
  ChevronRight,
  Filter,
  Locked,
  Subtract,
} from '@carbon/icons-react';
import type {
  ManagedDeviceType,
  Permission,
  PermissionGrant,
  PermissionId,
  Role,
} from '../../api/generated/models';
import { permissionGrantDeviceTypeIds } from '../auth/permissions';
import { permissionGroupOrder, presentPermission } from './permissionPresentation';

export type PermissionStateFilter = 'all' | 'granted' | 'conditional' | 'denied';

type Props = {
  permissions: Permission[];
  roles: Role[];
  deviceTypes: ManagedDeviceType[];
  search: string;
  groupFilter: string;
  stateFilter: PermissionStateFilter;
  effectivePermissions?: ReadonlyMap<string, ReadonlySet<PermissionId>>;
  editingRoleId?: string;
  selectedPermissionId?: string;
  changedPermissionIds?: ReadonlySet<string>;
  canManageRole: (role: Role) => boolean;
  canManagePermission: (role: Role, permission: Permission) => boolean;
  onSelectCell?: (role: Role, permission: Permission) => void;
  onEditRole?: (role: Role) => void;
  onDeleteRole?: (role: Role) => void;
};

const assuranceLabels: Record<PermissionGrant['minimumAssurance'], string> = {
  low: 'Low assurance',
  normal: 'Normal assurance',
  strong: 'Strong assurance',
  strong_mfa: 'Strong + MFA',
};

export function PermissionMatrix({
  permissions,
  roles,
  deviceTypes,
  search,
  groupFilter,
  stateFilter,
  effectivePermissions,
  editingRoleId,
  selectedPermissionId,
  changedPermissionIds = new Set(),
  canManageRole,
  canManagePermission,
  onSelectCell,
  onEditRole,
  onDeleteRole,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    const byGroup = new Map<string, Permission[]>();
    for (const permission of permissions) {
      const presented = presentPermission(permission);
      if (groupFilter !== 'all' && presented.group !== groupFilter) continue;
      if (needle && !`${presented.label} ${permission.id} ${permission.description}`.toLocaleLowerCase().includes(needle)) {
        continue;
      }
      if (!matchesStateFilter(permission, roles, effectivePermissions, stateFilter)) continue;
      byGroup.set(presented.group, [...(byGroup.get(presented.group) ?? []), permission]);
    }
    return permissionGroupOrder
      .filter((group) => byGroup.has(group))
      .map((group) => ({ name: group, permissions: byGroup.get(group) ?? [] }));
  }, [effectivePermissions, groupFilter, permissions, roles, search, stateFilter]);

  if (groups.length === 0) {
    return <div className="roles-matrix-empty"><h2>No matching permissions</h2><p>Reset filters or choose a different search term.</p></div>;
  }

  const matrixStyle = {
    minInlineSize: `${22 + roles.length * 11}rem`,
  } satisfies CSSProperties;

  return (
    <div className="roles-matrix-scroll" data-testid="permission-matrix">
      <div className="roles-matrix__sizing" style={matrixStyle}>
      <Table className="roles-matrix" useZebraStyles={false}>
        <colgroup>
          <col className="roles-matrix__permission-col" />
          {roles.map((role) => <col key={role.id} className="roles-matrix__role-col" />)}
        </colgroup>
        <TableHead>
          <TableRow>
            <TableHeader className="roles-matrix__permission-column">
              <span>Permission</span>
              <span className="roles-matrix__column-helper">Name and identifier</span>
            </TableHeader>
            {roles.map((role) => {
              const changedCount = role.id === editingRoleId ? changedPermissionIds.size : 0;
              return (
                <TableHeader
                  key={role.id}
                  className={`roles-matrix__role-header${role.id === editingRoleId ? ' roles-matrix__role-header--editing' : ''}`}
                >
                  <div className="roles-matrix__role-heading">
                    <span title={role.description ?? role.name}>{role.name}</span>
                    {role.systemKey === 'master' && <Locked size={16} aria-label="Protected system role" />}
                    {changedCount > 0 && <Tag type="blue" size="sm">{changedCount} changed</Tag>}
                    {!effectivePermissions && canManageRole(role) && (
                      <OverflowMenu iconDescription={`Actions for ${role.name}`} size="sm" flipped>
                        <OverflowMenuItem itemText="Edit role details" onClick={() => onEditRole?.(role)} />
                        <OverflowMenuItem isDelete itemText="Delete role" onClick={() => onDeleteRole?.(role)} />
                      </OverflowMenu>
                    )}
                  </div>
                </TableHeader>
              );
            })}
          </TableRow>
        </TableHead>
        <TableBody>
          {groups.map((group) => {
            const isCollapsed = !search && collapsed.has(group.name);
            return [
              <TableRow key={`group-${group.name}`} className="roles-matrix__group-row">
                <TableCell className="roles-matrix__permission-column roles-matrix__group-heading">
                  <button
                    type="button"
                    className="roles-matrix__group-toggle"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(group.name)) next.delete(group.name);
                      else next.add(group.name);
                      return next;
                    })}
                  >
                    {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                    <span>{group.name}</span>
                    <span className="roles-matrix__group-count">({group.permissions.length})</span>
                  </button>
                </TableCell>
                {roles.length > 0 && <TableCell colSpan={roles.length} aria-hidden="true" />}
              </TableRow>,
              ...(!isCollapsed ? group.permissions.map((permission) => (
                <PermissionRow
                  key={permission.id}
                  permission={permission}
                  roles={roles}
                  deviceTypes={deviceTypes}
                  effectivePermissions={effectivePermissions}
                  editingRoleId={editingRoleId}
                  selectedPermissionId={selectedPermissionId}
                  changedPermissionIds={changedPermissionIds}
                  canManagePermission={canManagePermission}
                  onSelectCell={onSelectCell}
                />
              )) : []),
            ];
          })}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}

function PermissionRow({
  permission,
  roles,
  deviceTypes,
  effectivePermissions,
  editingRoleId,
  selectedPermissionId,
  changedPermissionIds = new Set(),
  canManagePermission,
  onSelectCell,
}: Pick<Props, 'roles' | 'deviceTypes' | 'effectivePermissions' | 'editingRoleId' | 'selectedPermissionId' | 'changedPermissionIds' | 'canManagePermission' | 'onSelectCell'> & { permission: Permission }) {
  const presentation = presentPermission(permission);
  return (
    <TableRow className="roles-matrix__permission-row">
      <TableCell className="roles-matrix__permission-column">
        <Tooltip description={permission.description} align="right">
          <span className="roles-matrix__permission-name" tabIndex={0}>
            <span className="roles-matrix__permission-label">{presentation.label}</span>
            <code className="roles-matrix__permission-id">{permission.id}</code>
          </span>
        </Tooltip>
      </TableCell>
      {roles.map((role) => {
        const effective = effectivePermissions?.get(role.id)?.has(permission.id);
        const grants = role.permissionGrants.filter((grant) => grant.permissionId === permission.id);
        const state = effectivePermissions ? (effective ? 'granted' : 'denied') : configuredState(grants);
        const summary = effectivePermissions
          ? (effective ? 'Granted in this context' : 'Not granted in this context')
          : configuredSummary(grants, deviceTypes);
        const editable = !effectivePermissions && canManagePermission(role, permission);
        const label = `${editable ? 'Edit' : 'View'} ${presentation.label} for ${role.name}: ${summary}`;
        const modified = role.id === editingRoleId && changedPermissionIds.has(permission.id);
        const selected = role.id === editingRoleId && selectedPermissionId === permission.id;
        const icon = state === 'denied'
          ? <Subtract size={20} />
          : state === 'conditional'
            ? <span className="roles-matrix__conditional-icon"><Checkmark size={20} /><Filter size={14} /></span>
            : <Checkmark size={20} />;
        return (
          <TableCell
            key={role.id}
            className={`roles-matrix__cell roles-matrix__cell--${state}${modified ? ' roles-matrix__cell--modified' : ''}${selected ? ' roles-matrix__cell--selected' : ''}`}
          >
            <Tooltip description={summary} align="bottom">
              <button
                type="button"
                className="roles-matrix__cell-button"
                aria-label={label}
                aria-disabled={!editable}
                aria-pressed={selected || undefined}
                onClick={() => {
                  if (editable) onSelectCell?.(role, permission);
                }}
              >
                {icon}
                {modified && <span className="roles-matrix__modified-dot" aria-label="Modified in draft" />}
              </button>
            </Tooltip>
          </TableCell>
        );
      })}
    </TableRow>
  );
}

function matchesStateFilter(
  permission: Permission,
  roles: readonly Role[],
  effectivePermissions: ReadonlyMap<string, ReadonlySet<PermissionId>> | undefined,
  stateFilter: PermissionStateFilter,
) {
  if (stateFilter === 'all') return true;
  const states = roles.map((role) => effectivePermissions
    ? (effectivePermissions.get(role.id)?.has(permission.id) ? 'granted' : 'denied')
    : configuredState(role.permissionGrants.filter((grant) => grant.permissionId === permission.id)));
  if (stateFilter === 'denied') return states.length > 0 && states.every((state) => state === 'denied');
  return states.some((state) => state === stateFilter);
}

function configuredState(grants: readonly PermissionGrant[]): 'denied' | 'granted' | 'conditional' {
  if (grants.length === 0) return 'denied';
  return grants.some((grant) => grant.scope === 'everywhere' && grant.minimumAssurance === 'low')
    ? 'granted'
    : 'conditional';
}

function configuredSummary(grants: readonly PermissionGrant[], deviceTypes: readonly ManagedDeviceType[]) {
  if (grants.length === 0) return 'Not granted';
  if (configuredState(grants) === 'granted') return 'Granted without additional conditions';
  const names = new Map(deviceTypes.map((type) => [type.id, type.name]));
  return grants.map((grant) => {
    const parts: string[] = [];
    if (grant.minimumAssurance !== 'low') parts.push(assuranceLabels[grant.minimumAssurance]);
    if (grant.scope === 'anyManagedDevice') parts.push('Any managed device');
    if (grant.scope === 'selectedDeviceTypes') {
      const selected = permissionGrantDeviceTypeIds(grant).map((id) => names.get(id) ?? 'Unknown device type');
      parts.push(selected.join(', '));
    }
    return parts.join(' · ') || 'Granted without additional conditions';
  }).join(' OR ');
}
