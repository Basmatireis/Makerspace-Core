import type { Permission, PermissionGrant } from '../../api/generated/models';
import { normalizePermissionGrants } from '../auth/permissions';
import { presentPermission } from './permissionPresentation';

export function grantsForPermission(grants: readonly PermissionGrant[], permissionId: string) {
  return normalizePermissionGrants(grants.filter((grant) => grant.permissionId === permissionId));
}

export function permissionChanges(original: readonly PermissionGrant[], next: readonly PermissionGrant[]) {
  const ids = new Set([...original, ...next].map((grant) => grant.permissionId));
  return new Set(
    [...ids].filter(
      (permissionId) =>
        !sameGrants(grantsForPermission(original, permissionId), grantsForPermission(next, permissionId)),
    ),
  );
}

function sameGrants(left: readonly PermissionGrant[], right: readonly PermissionGrant[]) {
  return JSON.stringify(canonicalGrants(left)) === JSON.stringify(canonicalGrants(right));
}

function canonicalGrants(grants: readonly PermissionGrant[]) {
  return normalizePermissionGrants(grants)
    .map((grant) => ({ ...grant, deviceTypeIds: [...grant.deviceTypeIds].sort() }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function describePermissionChanges(
  original: readonly PermissionGrant[],
  next: readonly PermissionGrant[],
  permissions: readonly Permission[],
) {
  const permissionById = new Map(permissions.map((permission) => [permission.id, permission]));
  return [...permissionChanges(original, next)]
    .map((permissionId) => {
      const before = grantsForPermission(original, permissionId);
      const after = grantsForPermission(next, permissionId);
      const permission = permissionById.get(permissionId as Permission['id']);
      return {
        permissionId,
        label: permission ? presentPermission(permission).label : permissionId,
        kind: before.length === 0 ? 'added' : after.length === 0 ? 'removed' : 'changed',
      } as const;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}
