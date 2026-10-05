import { useMemo, useState, type ReactNode } from 'react';
import {
  Table,
  TableBody,
  TableCell,
  TableRow,
} from '@carbon/react';
import {
  Checkmark,
  ChevronDown,
  ChevronRight,
  Filter,
  Subtract,
} from '@carbon/icons-react';
import type {
  ManagedDeviceType,
  Permission,
  PermissionGrant,
  Role,
} from '../../api/generated/models';
import { permissionGrantDeviceTypeIds } from '../auth/permissions';
import { permissionGroupOrder, presentPermission } from './permissionPresentation';

type Props = {
  permissions: Permission[];
  roles: Role[];
  deviceTypes: ManagedDeviceType[];
  editingRoleId?: string;
  selectedPermissionId?: string;
  changedPermissionIds?: ReadonlySet<string>;
  canManagePermission: (role: Role, permission: Permission) => boolean;
  canSetState: (role: Role, permission: Permission, state: 'denied' | 'granted' | 'conditional') => boolean;
  onSelectCell?: (role: Role, permission: Permission) => void;
  onChangeState?: (role: Role, permission: Permission, state: 'denied' | 'granted' | 'conditional') => void;
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
  editingRoleId,
  selectedPermissionId,
  changedPermissionIds = new Set(),
  canManagePermission,
  canSetState,
  onSelectCell,
  onChangeState,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => {
    const byGroup = new Map<string, Permission[]>();
    for (const permission of permissions) {
      const presented = presentPermission(permission);
      byGroup.set(presented.group, [...(byGroup.get(presented.group) ?? []), permission]);
    }
    return permissionGroupOrder
      .filter((group) => byGroup.has(group))
      .map((group) => ({ name: group, permissions: byGroup.get(group) ?? [] }));
  }, [permissions]);

  if (groups.length === 0) {
    return <div className="roles-matrix-empty"><h2>No permissions available</h2></div>;
  }

  return (
    <div className="roles-matrix-scroll" data-testid="permission-matrix">
      <div className="roles-matrix__sizing">
      <Table className="roles-matrix" useZebraStyles={false}>
        <caption className="cds--visually-hidden">Permissions and access</caption>
        <colgroup>
          <col className="roles-matrix__permission-col" />
          <col className="roles-matrix__access-col" />
        </colgroup>
        <TableBody>
          {groups.map((group) => {
            const isCollapsed = collapsed.has(group.name);
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
                <TableCell aria-hidden="true" />
              </TableRow>,
              ...(!isCollapsed ? group.permissions.map((permission) => (
                <PermissionRow
                  key={permission.id}
                  permission={permission}
                  roles={roles}
                  deviceTypes={deviceTypes}
                  editingRoleId={editingRoleId}
                  selectedPermissionId={selectedPermissionId}
                  changedPermissionIds={changedPermissionIds}
                  canManagePermission={canManagePermission}
                  canSetState={canSetState}
                  onSelectCell={onSelectCell}
                  onChangeState={onChangeState}
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
  editingRoleId,
  selectedPermissionId,
  changedPermissionIds = new Set(),
  canManagePermission,
  canSetState,
  onSelectCell,
  onChangeState,
}: Pick<Props, 'roles' | 'deviceTypes' | 'editingRoleId' | 'selectedPermissionId' | 'changedPermissionIds' | 'canManagePermission' | 'canSetState' | 'onSelectCell' | 'onChangeState'> & { permission: Permission }) {
  const presentation = presentPermission(permission);
  const role = roles[0];
  if (!role) return null;
  const grants = role.permissionGrants.filter((grant) => grant.permissionId === permission.id);
  const state = configuredState(grants);
  const summary = configuredSummary(grants, deviceTypes);
  const editable = canManagePermission(role, permission);
  const modified = role.id === editingRoleId && changedPermissionIds.has(permission.id);
  const selected = role.id === editingRoleId && selectedPermissionId === permission.id;
  return (
    <TableRow className={`roles-matrix__permission-row${selected ? ' roles-matrix__permission-row--selected' : ''}`}>
      <TableCell className="roles-matrix__permission-column">
        <button
          type="button"
          className="roles-matrix__permission-name"
          aria-label={`View details for ${presentation.label}`}
          onClick={() => onSelectCell?.(role, permission)}
        >
          <span className="roles-matrix__permission-label">{presentation.label}</span>
          <code className="roles-matrix__permission-id">{permission.id}</code>
          {modified && <span className="roles-matrix__modified-dot" aria-label="Modified in draft" />}
        </button>
      </TableCell>
      <TableCell className={`roles-matrix__cell${modified ? ' roles-matrix__cell--modified' : ''}`}>
        <div className="roles-access-control" role="group" aria-label={`${presentation.label} access`}>
          <AccessOption state="denied" current={state} label="Not granted" icon={<Subtract size={16} />} />
          <AccessOption state="granted" current={state} label="Unconditional" icon={<Checkmark size={16} />} />
          <AccessOption state="conditional" current={state} label="Conditional" icon={<Filter size={16} />} />
        </div>
      </TableCell>
    </TableRow>
  );

  function AccessOption({ state: option, current, label, icon }: { state: 'denied' | 'granted' | 'conditional'; current: string; label: string; icon: ReactNode }) {
    const active = option === current;
    const optionDisabled = !editable || !canSetState(role, permission, option);
    return (
      <button
        type="button"
        className={`roles-access-control__option${active ? ' roles-access-control__option--active' : ''}`}
        aria-label={active ? `${editable ? 'Edit' : 'View'} ${presentation.label} for ${role.name}: ${summary}` : `Set ${presentation.label} for ${role.name} to ${label}`}
        aria-pressed={active}
        disabled={optionDisabled}
        title={active ? summary : undefined}
        onClick={() => {
          if (optionDisabled) return;
          if (active) onSelectCell?.(role, permission);
          else onChangeState?.(role, permission, option);
        }}
      >
        {icon}<span>{label}</span>
      </button>
    );
  }
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
