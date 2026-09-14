import type {
  CurrentUser,
  PermissionId as PermissionIdType,
  Role,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';

export { PermissionId };
export type { PermissionIdType };

export function hasPermission(
  currentUser: CurrentUser,
  permission: PermissionIdType,
): boolean {
  return currentUser.permissions.includes(permission);
}

export function hasAnyPermission(
  currentUser: CurrentUser,
  permissions: readonly PermissionIdType[],
): boolean {
  return permissions.some((permission) => hasPermission(currentUser, permission));
}

export function isOwnPerson(currentUser: CurrentUser, personId: string): boolean {
  return currentUser.person.id === personId;
}

export function canReadPerson(currentUser: CurrentUser, personId: string): boolean {
  return (
    hasPermission(currentUser, PermissionId.peoplereadall) ||
    (isOwnPerson(currentUser, personId) &&
      hasPermission(currentUser, PermissionId.peoplereadself))
  );
}

export function canUpdatePerson(currentUser: CurrentUser, personId: string): boolean {
  return (
    hasPermission(currentUser, PermissionId.peopleupdateall) ||
    (isOwnPerson(currentUser, personId) &&
      hasPermission(currentUser, PermissionId.peopleupdateself))
  );
}

export function canAccessSettings(currentUser: CurrentUser): boolean {
  return hasAnyPermission(currentUser, [
    PermissionId.peoplereadall,
    PermissionId.rolesread,
  ]);
}

export function canAccessOpenDays(currentUser: CurrentUser): boolean {
  return hasAnyPermission(currentUser, [
    PermissionId.open_daysread,
    PermissionId.open_daysmanage,
  ]);
}

export function canManageRoleMembership(
  currentUser: CurrentUser,
  role: Pick<Role, 'permissionIds' | 'systemKey'>,
): boolean {
  if (!hasPermission(currentUser, PermissionId.accountsrolesassign)) {
    return false;
  }

  const isMasterActor = currentUser.account.roles.some(
    (assignedRole) => assignedRole.systemKey === 'master',
  );
  if (isMasterActor) {
    return true;
  }

  return (
    role.systemKey !== 'master' &&
    role.permissionIds.every((permission) => hasPermission(currentUser, permission))
  );
}
