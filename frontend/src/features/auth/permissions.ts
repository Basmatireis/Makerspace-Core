import type { CurrentUser, PermissionGrant, PermissionId as PermissionIdType, Role } from '../../api/generated/models';
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

export function normalizePermissionGrants(grants: readonly PermissionGrant[]): PermissionGrant[] {
  return grants.map((grant) => ({
    permissionId: grant.permissionId,
    scope: grant.scope,
    deviceTypeIds: [...permissionGrantDeviceTypeIds(grant)],
    minimumAssurance: grant.minimumAssurance,
    // Omitted means no fresh sign-in is required, so grants without a window keep their former request shape.
    ...(grant.reauthWithinMinutes == null ? {} : { reauthWithinMinutes: grant.reauthWithinMinutes }),
  }));
}

/**
 * Whether the person may use a permission as far as the UI is concerned: it is held, or it is withheld only until
 * a fresh sign-in. The UI shows such pages and controls like any other; the API answers their first use with
 * `403 reauthentication_required`, the "Confirm it's you" dialog opens, and the request is repeated. Hiding them
 * instead would make a master's settings vanish ten minutes after signing in. Authorization itself stays with the
 * backend, so a withheld permission never reveals data the API does not send.
 */
export function hasPermission(currentUser: CurrentUser, permission: PermissionIdType): boolean {
  return currentUser.permissions.includes(permission) || isPendingPermission(currentUser, permission);
}

/** The permission is withheld only until a fresh sign-in. */
export function isPendingPermission(currentUser: CurrentUser, permission: PermissionIdType): boolean {
  // Tolerates partial current-user doubles that mock only the permission list.
  return (currentUser.authentication?.reauthenticationRequired ?? []).some(
    (entry) => entry.permissionId === permission,
  );
}

export function hasAnyPermission(currentUser: CurrentUser, permissions: readonly PermissionIdType[]): boolean {
  return permissions.some((permission) => hasPermission(currentUser, permission));
}

// Both billing-party and machine-job-operator searches use this permission set.
// Keep aligned with machinelogbook/catalog.go: canLookupParties.
export function canLookupJobParties(currentUser: CurrentUser): boolean {
  return hasAnyPermission(currentUser, ['orders.read', 'machine_jobs.create', 'organizations.read']);
}

export function isOwnPerson(currentUser: CurrentUser, personId: string): boolean {
  return currentUser.person.id === personId;
}

export function canReadPerson(currentUser: CurrentUser, personId: string): boolean {
  return (
    hasPermission(currentUser, 'people.read.all') ||
    (isOwnPerson(currentUser, personId) && hasPermission(currentUser, 'people.read.self'))
  );
}

export function canUpdatePerson(currentUser: CurrentUser, personId: string): boolean {
  return (
    hasPermission(currentUser, 'people.update.all') ||
    (isOwnPerson(currentUser, personId) && hasPermission(currentUser, 'people.update.self'))
  );
}

export const settingsPermissions: readonly PermissionIdType[] = [
  'roles.read',
  'managed_devices.read',
  'session_policies.manage',
  'surveys.read',
  'surveys.manage',
  'laborordnung.read',
  'laborordnung.manage',
  'laborordnung.requests.read',
  'visitor_enrollment.manage',
  'scim.manage',
  'oidc.manage',
  'mail.manage',
  'branding.manage',
  'invoicing.settings.manage',
  'configuration.export',
  'configuration.import',
  'printer_connectors.read',
  'open_days.manage',
  'trainings.manage',
  'privacy.read',
  'privacy.settings.manage',
  'privacy.requests.manage',
];

export function canAccessSettings(currentUser: CurrentUser): boolean {
  return hasAnyPermission(currentUser, settingsPermissions);
}

export function canAccessOpenDays(currentUser: CurrentUser): boolean {
  return hasAnyPermission(currentUser, ['open_days.read', 'open_days.manage']);
}

export const machineLogbookPermissions: readonly PermissionIdType[] = [
  'machines.read',
  'machine_jobs.read',
  'inventory.read',
  'statistics.read',
];

export function canAccessMachineLogbook(currentUser: CurrentUser): boolean {
  return hasAnyPermission(currentUser, machineLogbookPermissions);
}

export function canManageRoleMembership(
  currentUser: CurrentUser,
  role: Pick<Role, 'permissionGrants' | 'systemKey'>,
): boolean {
  if (!hasPermission(currentUser, 'people.roles.assign')) {
    return false;
  }

  const isMasterActor = currentUser.person.roles.some((assignedRole) => assignedRole.systemKey === 'master');
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
  if (!windowCoveredBy(own, requested)) return false;
  if (own.scope === 'everywhere') return true;
  if (requested.scope === 'everywhere') return false;
  if (own.scope === 'anyManagedDevice') return true;
  if (requested.scope === 'anyManagedDevice') return false;
  return permissionGrantDeviceTypeIds(requested).every((id) => permissionGrantDeviceTypeIds(own).includes(id));
}

export function permissionGrantCoveredBy(ownGrants: readonly PermissionGrant[], requested: PermissionGrant): boolean {
  const candidates = ownGrants.filter(
    (own) =>
      own.permissionId === requested.permissionId &&
      assuranceRank(own.minimumAssurance) <= assuranceRank(requested.minimumAssurance) &&
      windowCoveredBy(own, requested),
  );
  if (requested.scope !== 'selectedDeviceTypes') {
    return candidates.some((own) => grantCoveredBy(own, requested));
  }
  return permissionGrantDeviceTypeIds(requested).every((deviceTypeId) =>
    candidates.some(
      (own) =>
        own.scope === 'everywhere' ||
        own.scope === 'anyManagedDevice' ||
        (own.scope === 'selectedDeviceTypes' && permissionGrantDeviceTypeIds(own).includes(deviceTypeId)),
    ),
  );
}

/** A fresh sign-in window is part of the delegation envelope: a delegated grant may be stricter, never looser. */
function windowCoveredBy(own: PermissionGrant, requested: PermissionGrant) {
  if (own.reauthWithinMinutes == null) return true;
  return requested.reauthWithinMinutes != null && requested.reauthWithinMinutes <= own.reauthWithinMinutes;
}

function assuranceRank(value: PermissionGrant['minimumAssurance']) {
  return ['low', 'normal', 'strong', 'strong_mfa'].indexOf(value);
}

export function permissionGrantsValid(grants: readonly PermissionGrant[]) {
  return (
    grants.length ===
      new Set(grants.map((grant) => JSON.stringify([grant.permissionId, grant.scope, grant.minimumAssurance]))).size &&
    grants.every(
      (grant) =>
        permissionGrantDeviceTypeIds(grant).length === new Set(permissionGrantDeviceTypeIds(grant)).size &&
        (grant.reauthWithinMinutes == null ||
          (Number.isInteger(grant.reauthWithinMinutes) &&
            grant.reauthWithinMinutes >= 1 &&
            grant.reauthWithinMinutes <= 1440)) &&
        (grant.scope === 'selectedDeviceTypes'
          ? permissionGrantDeviceTypeIds(grant).length > 0
          : permissionGrantDeviceTypeIds(grant).length === 0),
    )
  );
}
