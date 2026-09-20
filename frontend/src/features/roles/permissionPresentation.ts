import type { Permission, PermissionId } from '../../api/generated/models';

export type PermissionPresentation = {
  group: string;
  label: string;
};

export const permissionGroupOrder = [
  'People',
  'Accounts & authentication',
  'Roles & audit',
  'Open Days',
  'Managed devices',
  'Lab Rules',
  'Visitor enrollment',
  'Supervisor tools',
  'Identity providers',
  'Provisioning',
  'Mail',
  'Other',
] as const;

const presentation: Partial<Record<PermissionId, PermissionPresentation>> = {
  'people.read.self': { group: 'People', label: 'View own profile' },
  'people.read.all': { group: 'People', label: 'View all people' },
  'people.create': { group: 'People', label: 'Create people' },
  'people.update.self': { group: 'People', label: 'Edit own profile' },
  'people.update.all': { group: 'People', label: 'Edit all people' },
  'people.delete': { group: 'People', label: 'Delete people' },
  'people.read.matriculation': { group: 'People', label: 'View matriculation numbers' },
  'people.update.matriculation': { group: 'People', label: 'Edit matriculation numbers' },
  'people.profile_image.update.self': { group: 'People', label: 'Update own profile image' },
  'people.profile_image.update.all': { group: 'People', label: 'Update all profile images' },
  'people.profile_image.remove.self': { group: 'People', label: 'Remove own profile image' },
  'people.profile_image.remove.all': { group: 'People', label: 'Remove all profile images' },
  'accounts.read': { group: 'Accounts & authentication', label: 'View accounts' },
  'accounts.create': { group: 'Accounts & authentication', label: 'Create accounts' },
  'accounts.delete': { group: 'Accounts & authentication', label: 'Delete accounts' },
  'accounts.enable': { group: 'Accounts & authentication', label: 'Enable accounts' },
  'accounts.disable': { group: 'Accounts & authentication', label: 'Disable accounts' },
  'accounts.login_email.update': { group: 'Accounts & authentication', label: 'Change login email' },
  'accounts.password.set': { group: 'Accounts & authentication', label: 'Set passwords' },
  'accounts.password.reset': { group: 'Accounts & authentication', label: 'Reset passwords' },
  'accounts.password.enroll.self': { group: 'Accounts & authentication', label: 'Enroll own password' },
  'accounts.password.enroll.all': { group: 'Accounts & authentication', label: 'Enroll account passwords' },
  'accounts.password.remove.self': { group: 'Accounts & authentication', label: 'Remove own password' },
  'accounts.password.remove.all': { group: 'Accounts & authentication', label: 'Remove account passwords' },
  'accounts.pin.enroll.self': { group: 'Accounts & authentication', label: 'Enroll own PIN' },
  'accounts.pin.enroll.all': { group: 'Accounts & authentication', label: 'Enroll account PINs' },
  'accounts.pin.remove.self': { group: 'Accounts & authentication', label: 'Remove own PIN' },
  'accounts.pin.remove.all': { group: 'Accounts & authentication', label: 'Remove account PINs' },
  'accounts.pin.reset': { group: 'Accounts & authentication', label: 'Reset PINs' },
  'accounts.roles.assign': { group: 'Roles & audit', label: 'Assign roles' },
  'roles.read': { group: 'Roles & audit', label: 'View roles' },
  'roles.manage': { group: 'Roles & audit', label: 'Manage roles' },
  'audit.read': { group: 'Roles & audit', label: 'View audit events' },
  'open_days.read': { group: 'Open Days', label: 'View Open Days' },
  'open_days.read_assignments': { group: 'Open Days', label: 'View Open Day assignments' },
  'open_days.signup': { group: 'Open Days', label: 'Sign up for Open Days' },
  'open_days.assign': { group: 'Open Days', label: 'Assign Open Day participants' },
  'open_days.manage': { group: 'Open Days', label: 'Manage Open Days' },
  'managed_devices.read': { group: 'Managed devices', label: 'View managed devices' },
  'managed_devices.manage': { group: 'Managed devices', label: 'Manage devices and types' },
  'laborordnung.read': { group: 'Lab Rules', label: 'View Lab Rules' },
  'laborordnung.manage': { group: 'Lab Rules', label: 'Manage Lab Rules' },
  'laborordnung.requests.read': { group: 'Lab Rules', label: 'View confirmation requests' },
  'laborordnung.confirm': { group: 'Lab Rules', label: 'Confirm Lab Rules evidence' },
  'visitor_enrollment.manage': { group: 'Visitor enrollment', label: 'Manage visitor enrollment' },
  'supervisor_dashboard.read': { group: 'Supervisor tools', label: 'View supervisor dashboard' },
  'identities.oidc.link.self': { group: 'Identity providers', label: 'Link own OIDC identity' },
  'identities.oidc.link.all': { group: 'Identity providers', label: 'Link account OIDC identities' },
  'identities.oidc.unlink.self': { group: 'Identity providers', label: 'Unlink own OIDC identity' },
  'identities.oidc.unlink.all': { group: 'Identity providers', label: 'Unlink account OIDC identities' },
  'oidc.manage': { group: 'Identity providers', label: 'Manage OIDC providers' },
  'scim.manage': { group: 'Provisioning', label: 'Manage SCIM provisioning' },
  'mail.manage': { group: 'Mail', label: 'Manage email delivery' },
};

export function presentPermission(permission: Pick<Permission, 'id'>): PermissionPresentation {
  return presentation[permission.id] ?? {
    group: 'Other',
    label: permission.id
      .split('.')
      .map((part) => part.replaceAll('_', ' '))
      .join(' · '),
  };
}
