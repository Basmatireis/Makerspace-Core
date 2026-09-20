import { useMemo, useState } from 'react';
import {
  OverflowMenu,
  OverflowMenuItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
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

type Props = {
  permissions: Permission[];
  roles: Role[];
  deviceTypes: ManagedDeviceType[];
  search: string;
  effectivePermissions?: ReadonlyMap<string, ReadonlySet<PermissionId>>;
  canManageRole: (role: Role) => boolean;
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
  effectivePermissions,
  canManageRole,
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
      if (needle && !`${presented.label} ${permission.id} ${permission.description}`.toLocaleLowerCase().includes(needle)) {
        continue;
      }
      byGroup.set(presented.group, [...(byGroup.get(presented.group) ?? []), permission]);
    }
    return permissionGroupOrder
      .filter((group) => byGroup.has(group))
      .map((group) => ({ name: group, permissions: byGroup.get(group) ?? [] }));
  }, [permissions, search]);

  if (groups.length === 0) {
    return <div className="roles-matrix-empty"><h2>No matching permissions</h2><p>Try a different permission name or identifier.</p></div>;
  }

  return (
    <div className="roles-matrix-scroll" data-testid="permission-matrix">
      <Table className="roles-matrix" useZebraStyles={false}>
        <TableHead>
          <TableRow>
            <TableHeader className="roles-matrix__permission-column">Permission</TableHeader>
            {roles.map((role) => (
              <TableHeader key={role.id} className="roles-matrix__role-header">
                <div className="roles-matrix__role-heading">
                  <span title={role.description ?? undefined}>{role.name}</span>
                  {role.systemKey === 'master' && <Locked size={16} aria-label="Protected system role" />}
                  {!effectivePermissions && canManageRole(role) && (
                    <OverflowMenu iconDescription={`Actions for ${role.name}`} size="sm" flipped>
                      <OverflowMenuItem itemText="Edit role" onClick={() => onEditRole?.(role)} />
                      <OverflowMenuItem isDelete itemText="Delete role" onClick={() => onDeleteRole?.(role)} />
                    </OverflowMenu>
                  )}
                </div>
              </TableHeader>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {groups.map((group) => {
            const isCollapsed = !search && collapsed.has(group.name);
            return [
              <TableRow key={`group-${group.name}`} className="roles-matrix__group-row">
                <TableCell colSpan={roles.length + 1}>
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
              </TableRow>,
              ...(!isCollapsed ? group.permissions.map((permission) => (
                <PermissionRow
                  key={permission.id}
                  permission={permission}
                  roles={roles}
                  deviceTypes={deviceTypes}
                  effectivePermissions={effectivePermissions}
                  canManageRole={canManageRole}
                  onSelectCell={onSelectCell}
                />
              )) : []),
            ];
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function PermissionRow({
  permission,
  roles,
  deviceTypes,
  effectivePermissions,
  canManageRole,
  onSelectCell,
}: Omit<Props, 'permissions' | 'search' | 'onEditRole' | 'onDeleteRole'> & { permission: Permission }) {
  const presentation = presentPermission(permission);
  return (
    <TableRow className="roles-matrix__permission-row">
      <TableCell className="roles-matrix__permission-column">
        <Tooltip description={permission.description} align="right">
          <span className="roles-matrix__permission-label" tabIndex={0}>{presentation.label}</span>
        </Tooltip>
      </TableCell>
      {roles.map((role) => {
        const effective = effectivePermissions?.get(role.id)?.has(permission.id);
        const grants = role.permissionGrants.filter((grant) => grant.permissionId === permission.id);
        const state = effectivePermissions ? (effective ? 'granted' : 'denied') : configuredState(grants);
        const summary = effectivePermissions
          ? (effective ? 'Granted in this context' : 'Not granted in this context')
          : configuredSummary(grants, deviceTypes);
        const editable = !effectivePermissions && canManageRole(role);
        const label = `${editable ? 'Edit' : 'View'} ${presentation.label} for ${role.name}: ${summary}`;
        const icon = state === 'denied'
          ? <Subtract size={20} />
          : state === 'conditional'
            ? <span className="roles-matrix__conditional-icon"><Checkmark size={20} /><Filter size={14} /></span>
            : <Checkmark size={20} />;
        return (
          <TableCell key={role.id} className={`roles-matrix__cell roles-matrix__cell--${state}`}>
            <Tooltip description={summary} align="bottom">
              <button
                type="button"
                className="roles-matrix__cell-button"
                aria-label={label}
                aria-disabled={!editable}
                onClick={() => {
                  if (editable) onSelectCell?.(role, permission);
                }}
              >
                {icon}
              </button>
            </Tooltip>
          </TableCell>
        );
      })}
    </TableRow>
  );
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
