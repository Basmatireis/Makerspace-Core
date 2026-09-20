import type {
  CurrentUser,
  PermissionGrant,
  PermissionId as PermissionIdType,
  Role,
} from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';

export { PermissionId };
export type { PermissionIdType };

export function permissionGrantDeviceTypeIds(
  grant: Pick<PermissionGrant, 'deviceTypeIds'>,
): PermissionGrant['deviceTypeIds'] {
  // Older responses could contain null despite the non-null OpenAPI contract.
  // Treat that legacy representation as the semantic empty set.
  return Array.isArray(grant.deviceTypeIds) ? grant.deviceTypeIds : [];
}

export function normalizePermissionGrants(
  grants: readonly PermissionGrant[],
): PermissionGrant[] {
  return grants.map((grant) => ({
    permissionId: grant.permissionId,
    scope: grant.scope,
    deviceTypeIds: [...permissionGrantDeviceTypeIds(grant)],
    minimumAssurance: grant.minimumAssurance,
  }));
}

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

export const settingsPermissions: readonly PermissionIdType[] = [
  PermissionId.peoplereadall,
  PermissionId.rolesread,
  PermissionId.managed_devicesread,
  PermissionId.laborordnungread,
  PermissionId.laborordnungmanage,
  PermissionId.laborordnungrequestsread,
  PermissionId.visitor_enrollmentmanage,
  PermissionId.scimmanage,
  PermissionId.oidcmanage,
  PermissionId.mailmanage,
	PermissionId.supervisor_dashboardread,
	PermissionId.organizationsread,
	PermissionId.organizationsmanage,
	PermissionId.pricingread,
	PermissionId.pricingmanage,
];

export function canAccessSettings(currentUser: CurrentUser): boolean {
  return hasAnyPermission(currentUser, settingsPermissions);
}

export function canAccessOpenDays(currentUser: CurrentUser): boolean {
  return hasAnyPermission(currentUser, [
    PermissionId.open_daysread,
    PermissionId.open_daysmanage,
  ]);
}

export const machineLogbookPermissions: readonly PermissionIdType[] = [
  PermissionId.machinesread,
  PermissionId.machine_jobsread,
  PermissionId.machine_jobsreview,
  PermissionId.inventoryread,
  PermissionId.statisticsread,
];

export function canAccessMachineLogbook(currentUser: CurrentUser): boolean {
  return hasAnyPermission(currentUser, machineLogbookPermissions);
}

export function canManageRoleMembership(
  currentUser: CurrentUser,
  role: Pick<Role, 'permissionGrants' | 'systemKey'>,
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
    role.permissionGrants.every((grant) => permissionGrantCoveredBy(currentUser.delegablePermissionGrants, grant))
  );
}

export function grantCoveredBy(own: PermissionGrant, requested: PermissionGrant): boolean {
  if (own.permissionId !== requested.permissionId) return false;
  if (assuranceRank(own.minimumAssurance) > assuranceRank(requested.minimumAssurance)) return false;
  if (own.scope === 'everywhere') return true;
  if (requested.scope === 'everywhere') return false;
  if (own.scope === 'anyManagedDevice') return true;
  if (requested.scope === 'anyManagedDevice') return false;
  return permissionGrantDeviceTypeIds(requested).every((id) => permissionGrantDeviceTypeIds(own).includes(id));
}

export function permissionGrantCoveredBy(
  ownGrants: readonly PermissionGrant[],
  requested: PermissionGrant,
): boolean {
  const candidates = ownGrants.filter((own) =>
    own.permissionId === requested.permissionId &&
    assuranceRank(own.minimumAssurance) <= assuranceRank(requested.minimumAssurance));
  if (requested.scope !== 'selectedDeviceTypes') {
    return candidates.some((own) => grantCoveredBy(own, requested));
  }
  return permissionGrantDeviceTypeIds(requested).every((deviceTypeId) => candidates.some((own) =>
    own.scope === 'everywhere' || own.scope === 'anyManagedDevice' ||
    (own.scope === 'selectedDeviceTypes' && permissionGrantDeviceTypeIds(own).includes(deviceTypeId))));
}

function assuranceRank(value: PermissionGrant['minimumAssurance']) {
  return ['low', 'normal', 'strong', 'strong_mfa'].indexOf(value);
}

export function permissionGrantsValid(grants: readonly PermissionGrant[]) {
  return grants.length === new Set(grants.map((grant) => JSON.stringify([
    grant.permissionId, grant.scope, [...permissionGrantDeviceTypeIds(grant)].sort(), grant.minimumAssurance,
  ]))).size && grants.every((grant) =>
    grant.scope !== 'selectedDeviceTypes' || permissionGrantDeviceTypeIds(grant).length > 0,
  );
}
