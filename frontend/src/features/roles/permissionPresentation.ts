import type { Permission, PermissionId } from '../../api/generated/models';

export type PermissionPresentation = {
  group: PermissionGroup;
  label: string;
};

/** The groups of the role editor, in app-area order. */
export const permissionGroupOrder = [
  'People',
  'Accounts & sign-in',
  'Roles & audit',
  'Open Days',
  'Events',
  'Trainings',
  'Workshop',
  'Inventory',
  'Sales & cash',
  'Signage',
  'Notifications',
  'Devices & kiosk',
  'Lab Rules',
  'Privacy',
  'Settings & integrations',
] as const;

export type PermissionGroup = (typeof permissionGroupOrder)[number];

type Catalog = Record<PermissionGroup, readonly (readonly [PermissionId, string])[]>;

/**
 * Every permission with its label, grouped by app area. Within a group the order is: reading first, then creating,
 * editing and managing, then deleting and other destructive actions. Adding a permission to the API without an entry
 * here fails the unit test of this file.
 */
const catalog: Catalog = {
  People: [
    ['people.read.self', 'View own profile'],
    ['people.read.all', 'View all people'],
    ['people.read.matriculation', 'View matriculation numbers'],
    ['people.create', 'Create people'],
    ['people.update.self', 'Edit own profile'],
    ['people.update.all', 'Edit all people'],
    ['people.update.matriculation', 'Edit matriculation numbers'],
    ['people.profile_image.update.self', 'Update own profile image'],
    ['people.profile_image.update.all', 'Update all profile images'],
    ['people.profile_image.remove.self', 'Remove own profile image'],
    ['people.profile_image.remove.all', 'Remove all profile images'],
    ['people.merge', 'Merge duplicate people'],
    ['people.delete', 'Delete people'],
  ],
  'Accounts & sign-in': [
    ['web.sign_in', 'Sign in to the web app'],
    ['accounts.read', 'View accounts'],
    ['accounts.create', 'Create accounts'],
    ['accounts.enable', 'Activate accounts'],
    ['accounts.login_email.update', 'Change login email'],
    ['accounts.password.enroll.self', 'Enroll own password'],
    ['accounts.password.enroll.all', 'Enroll account passwords'],
    ['accounts.password.set', 'Set passwords'],
    ['accounts.password.reset', 'Reset passwords'],
    ['accounts.pin.enroll.self', 'Enroll own PIN'],
    ['accounts.pin.enroll.all', 'Enroll account PINs'],
    ['accounts.pin.reset', 'Reset PINs'],
    ['identities.oidc.link.self', 'Link own OIDC identity'],
    ['identities.oidc.link.all', 'Link account OIDC identities'],
    ['accounts.mfa.reset', 'Reset second factors'],
    ['accounts.disable', 'Disable accounts'],
    ['accounts.password.remove.self', 'Remove own password'],
    ['accounts.password.remove.all', 'Remove account passwords'],
    ['accounts.pin.remove.self', 'Remove own PIN'],
    ['accounts.pin.remove.all', 'Remove account PINs'],
    ['identities.oidc.unlink.self', 'Unlink own OIDC identity'],
    ['identities.oidc.unlink.all', 'Unlink account OIDC identities'],
    ['accounts.delete', 'Delete accounts'],
  ],
  'Roles & audit': [
    ['roles.read', 'View roles'],
    ['audit.read', 'View audit events'],
    ['people.roles.assign', 'Assign roles'],
    ['roles.manage', 'Manage roles'],
  ],
  'Open Days': [
    ['open_days.read', 'View Open Days'],
    ['open_days.read_assignments', 'View Open Day assignments'],
    ['supervisor_dashboard.read', 'View supervisor staffing overview'],
    ['open_days.signup', 'Sign up for Open Days'],
    ['open_days.assign', 'Assign Open Day participants'],
    ['open_days.manage', 'Manage Open Days'],
  ],
  Events: [
    ['events.read', 'View events'],
    ['events.read_assignments', 'See event helper names'],
    ['events.signup', 'Join and leave event shifts'],
    ['events.assign', 'Assign event helpers'],
    ['events.staffing.manage', 'Manage event staffing'],
    ['events.manage', 'Manage events'],
  ],
  Trainings: [
    ['training_records.read.self', 'View own training records'],
    ['training_records.read.all', 'View all training records'],
    ['training_records.update.self', 'Set own training status'],
    ['training_records.update', 'Set training status of others'],
    ['trainings.manage', 'Manage trainings and competencies'],
  ],
  Workshop: [
    ['machines.read', 'View machines'],
    ['machine_jobs.read', 'View machine jobs'],
    ['printer_connectors.read', 'View printer connectors'],
    ['print_artifacts.read', 'View print previews and files'],
    ['statistics.read', 'View statistics'],
    ['machine_jobs.create', 'Create jobs'],
    ['machine_jobs.edit', 'Edit jobs and billing'],
    ['machine_jobs.override_price', 'Override job prices'],
    ['printer_slots.assign', 'Assign printer slots'],
    ['machines.manage', 'Manage machines and types'],
    ['printer_connectors.manage', 'Manage printer connectors'],
    ['printer_connectors.credentials.manage', 'Manage printer connector credentials'],
    ['machine_jobs.delete', 'Delete jobs and runs'],
  ],
  Inventory: [
    ['inventory.read', 'View inventory'],
    ['inventory.receive', 'Receive goods'],
    ['inventory.consume', 'Record consumption'],
    ['inventory.articles.manage', 'Manage articles, types and spools'],
    ['filament_spools.manage', 'Manage filament spools'],
    ['inventory.correct', 'Correct stock and retire spools'],
    ['inventory.delete', 'Delete articles and spools'],
    ['inventory.ledger.delete', 'Delete ledger entries'],
  ],
  'Sales & cash': [
    ['orders.read', 'View orders'],
    ['payments.read', 'View payments'],
    ['external_invoice_requests.read', 'View invoice requests'],
    ['cash_movements.read', 'View cash movements'],
    ['organizations.read', 'View billing organizations'],
    ['pricing.read', 'View pricing'],
    ['orders.write', 'Create and edit draft orders'],
    ['orders.finalize', 'Finalize orders'],
    ['payments.record', 'Record payments'],
    ['external_invoice_requests.manage', 'Prepare invoice requests'],
    ['external_invoice_requests.approve', 'Approve invoice requests'],
    ['cash_movements.record', 'Record cash movements'],
    ['organizations.manage', 'Manage billing organizations'],
    ['pricing.manage', 'Manage pricing'],
    ['orders.reverse', 'Reverse orders'],
    ['payments.reverse', 'Refund and correct payments'],
    ['cash_movements.manage', 'Edit and delete cash movements'],
  ],
  Signage: [
    ['signage.read', 'View signage'],
    ['signage.content.manage', 'Manage signage content'],
    ['signage.publish', 'Publish signage'],
    ['signage.override', 'Override running signage'],
    ['signage.manage', 'Manage signage displays'],
  ],
  Notifications: [
    ['notification_rules.read', 'View notification rules'],
    ['notifications.send', 'Send in-app messages'],
    ['notification_rules.manage', 'Manage notification rules'],
  ],
  'Devices & kiosk': [
    ['managed_devices.read', 'View managed devices'],
    ['attendance.read', 'View attendance'],
    ['attendance.statistics.read', 'View attendance statistics'],
    ['surveys.read', 'View surveys and results'],
    ['attendance.assist', 'Assist with check-in'],
    ['attendance.correct', 'Correct attendance'],
    ['visitor_enrollment.manage', 'Manage visitor enrollment'],
    ['surveys.manage', 'Manage surveys'],
    ['session_policies.manage', 'Manage session policies'],
    ['managed_devices.manage', 'Manage devices and types'],
  ],
  'Lab Rules': [
    ['laborordnung.read', 'View Lab Rules'],
    ['laborordnung.confirmations.read', 'View Lab Rules confirmations'],
    ['laborordnung.manage', 'Manage Lab Rules'],
  ],
  Privacy: [
    ['privacy.read', 'View privacy settings'],
    ['privacy.requests.manage', 'Manage data-subject requests'],
    ['privacy.requests.execute', 'Execute data-subject requests'],
    ['privacy.settings.manage', 'Manage privacy settings'],
    ['privacy.policies.manage', 'Manage retention policies and holds'],
    ['privacy.retention.execute', 'Run retention'],
  ],
  'Settings & integrations': [
    ['configuration.export', 'Export configuration'],
    ['configuration.import', 'Import configuration'],
    ['mail.manage', 'Manage email delivery'],
    ['branding.manage', 'Manage branding'],
    ['invoicing.settings.manage', 'Manage invoicing settings'],
    ['oidc.manage', 'Manage OIDC providers'],
    ['scim.manage', 'Manage SCIM provisioning'],
  ],
};

const presentation = new Map<string, PermissionPresentation & { order: number }>();
for (const group of permissionGroupOrder) {
  for (const [id, label] of catalog[group]) {
    presentation.set(id, { group, label, order: presentation.size });
  }
}

/** Whether the permission is known to the role editor; a unit test requires this for every API permission id. */
export function hasPermissionPresentation(id: string): boolean {
  return presentation.has(id);
}

export function presentPermission(permission: Pick<Permission, 'id'>): PermissionPresentation {
  return (
    presentation.get(permission.id) ?? {
      // Only reachable when the API is newer than this build; the unit test keeps the two in step.
      group: 'Settings & integrations',
      label: permission.id
        .split('.')
        .map((part) => part.replaceAll('_', ' '))
        .join(' · '),
    }
  );
}

/** Orders permissions by app area, then reading before editing before destructive actions. */
export function sortPermissionsForDisplay<T extends Pick<Permission, 'id'>>(permissions: readonly T[]): T[] {
  const position = (permission: T) => presentation.get(permission.id)?.order ?? Number.MAX_SAFE_INTEGER;
  return [...permissions].sort((left, right) => position(left) - position(right) || left.id.localeCompare(right.id));
}
