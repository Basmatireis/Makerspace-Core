import type { AuditEvent } from '../../api/generated/models';

export const actionLabels: Record<string, string> = {
  'account.created': 'Created account',
  'account.deleted': 'Deleted account',
  'account.disabled': 'Disabled account',
  'account.email_verification_requested': 'Requested email verification',
  'account.email_verified': 'Verified email address',
  'account.invitation_completed': 'Completed account invitation',
  'account.invitation_issued': 'Issued account invitation',
  'account.login_email_updated': 'Updated login email',
  'account.password_changed': 'Changed password',
  'account.password_removed': 'Removed password',
  'account.password_reset_by_admin_cli': 'Reset password administratively',
  'account.password_reset_completed': 'Completed password reset',
  'account.password_reset_issued': 'Issued password reset',
  'account.password_reset_requested': 'Requested password reset',
  'account.password_set': 'Set password',
  'account.pin_enrolled': 'Enrolled PIN',
  'account.pin_enrollment_completed': 'Completed PIN enrollment',
  'account.pin_enrollment_issued': 'Issued PIN enrollment',
  'account.pin_removed': 'Removed PIN',
  'account.role_assigned': 'Assigned role',
  'account.role_removed': 'Removed role',
  'account.enabled': 'Enabled account',
  'auth.login_succeeded': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.oidc_jit_provisioned': 'Provisioned account with OpenID Connect',
  'auth.oidc_linked': 'Linked OpenID Connect identity',
  'auth.oidc_login_succeeded': 'Signed in with OpenID Connect',
  'auth.oidc_unlinked': 'Unlinked OpenID Connect identity',
  'auth.pin_login_failed': 'PIN sign-in failed',
  'auth.pin_login_succeeded': 'Signed in with PIN',
  'auth.reauthenticated': 'Reauthenticated',
  'billing_party.pricing_group_updated': 'Updated billing pricing group',
  'device_type.created': 'Created device type',
  'device_type.deleted': 'Deleted device type',
  'device_type.updated': 'Updated device type',
  'file.created': 'Created file',
  'file.deleted': 'Deleted file',
  'inventory.adjustment': 'Adjusted inventory',
  'inventory.mark_empty': 'Marked inventory empty',
  'inventory.purchase': 'Recorded inventory purchase',
  'laborordnung.request.confirmed': 'Approved Lab Rules confirmation',
  'laborordnung.request.created': 'Created Lab Rules confirmation request',
  'laborordnung.version.created': 'Created Lab Rules version',
  'laborordnung.version.published': 'Published Lab Rules version',
  'machine.created': 'Created machine',
  'machine.updated': 'Updated machine',
  'machine_job.billing_updated': 'Updated job billing',
  'machine_job.confirmed': 'Confirmed machine job',
  'machine_job.created': 'Created machine job',
  'machine_job.ingested': 'Ingested machine job',
  'machine_job.price_override_cleared': 'Cleared job price override',
  'machine_job.price_overridden': 'Overrode job price',
  'machine_job.updated': 'Updated machine job',
  'machine_job.usages_replaced': 'Updated job material usage',
  'machine_type.created': 'Created machine type',
  'machine_type.updated': 'Updated machine type',
  'mail.configuration_updated': 'Updated email delivery configuration',
  'managed_device.created': 'Created managed device',
  'managed_device.deleted': 'Deleted managed device',
  'managed_device.revoked': 'Revoked managed device',
  'managed_device.token_rotated': 'Rotated managed-device token',
  'managed_device.updated': 'Updated managed device',
  'material.created': 'Created material',
  'material.updated': 'Updated material',
  'oidc.provider_created': 'Created OpenID Connect provider',
  'oidc.provider_secret_reencrypted': 'Re-encrypted OpenID Connect provider secret',
  'oidc.provider_updated': 'Updated OpenID Connect provider',
  'open_day.assignment.created': 'Created Open Day assignment',
  'open_day.cancelled': 'Cancelled Open Day',
  'open_day.created': 'Created Open Day',
  'open_day.deleted': 'Deleted Open Day',
  'open_day.person_assigned': 'Assigned person to Open Day',
  'open_day.person_unassigned': 'Removed person from Open Day',
  'open_day.self_joined': 'Joined Open Day',
  'open_day.self_left': 'Left Open Day',
  'open_day.updated': 'Updated Open Day',
  'open_day_academic_break.created': 'Created academic break',
  'open_day_academic_break.deleted': 'Deleted academic break',
  'open_day_academic_break.updated': 'Updated academic break',
  'open_day_period.archived': 'Archived Open Day period',
  'open_day_period.created': 'Created Open Day period',
  'open_day_period.draft': 'Returned Open Day period to draft',
  'open_day_period.published': 'Published Open Day period',
  'open_day_period.staffing': 'Opened Open Day staffing',
  'open_day_period.updated': 'Updated Open Day period',
  'organization.created': 'Created organization',
  'organization.updated': 'Updated organization',
  'person.created': 'Created person',
  'person.deleted': 'Deleted person',
  'person.profile_image.removed': 'Removed profile image',
  'person.profile_image.updated': 'Updated profile image',
  'person.updated': 'Updated person',
  'pricing_group.created': 'Created pricing group',
  'pricing_group.updated': 'Updated pricing group',
  'pricing_rule.created': 'Created pricing rule',
  'pricing_rule.updated': 'Updated pricing rule',
  'role.assigned': 'Assigned role',
  'role.created': 'Created role',
  'role.deleted': 'Deleted role',
  'role.permissions_replaced': 'Replaced role permissions',
  'role.updated': 'Updated role',
  'scim.account_reconciled': 'Reconciled SCIM account',
  'scim.connector_created': 'Created SCIM connector',
  'scim.connector_updated': 'Updated SCIM connector',
  'scim.token_revoked': 'Revoked SCIM token',
  'scim.token_rotated': 'Rotated SCIM token',
  'scim.user_created': 'Created SCIM user',
  'scim.user_deprovisioned': 'Deprovisioned SCIM user',
  'scim.user_updated': 'Updated SCIM user',
  'system.master_bootstrapped': 'Bootstrapped master account',
  'system.master_recovered': 'Recovered master account',
  'visitor_enrollment.account_created': 'Created visitor account',
  'visitor_enrollment.configuration_updated': 'Updated visitor enrollment configuration',
  'visitor_enrollment.context_created': 'Started visitor enrollment',
  'visitor_enrollment.person_created': 'Created visitor person',
};

export const resourceLabels: Record<string, string> = {
  account: 'Account',
  auth_identity: 'Authentication identity',
  billing_party: 'Billing party',
  device_type: 'Device type',
  file: 'File',
  laborordnung_request: 'Lab Rules request',
  laborordnung_version: 'Lab Rules version',
  machine: 'Machine',
  machine_job: 'Machine job',
  machine_type: 'Machine type',
  mail_configuration: 'Email delivery configuration',
  managed_device: 'Managed device',
  material: 'Material',
  oidc_provider: 'OpenID Connect provider',
  open_day: 'Open Day',
  open_day_academic_break: 'Academic break',
  open_day_assignment: 'Open Day assignment',
  open_day_period: 'Open Day period',
  organization: 'Organization',
  person: 'Person',
  pricing_group: 'Pricing group',
  pricing_rule: 'Pricing rule',
  role: 'Role',
  scim_connector: 'SCIM connector',
  scim_user: 'SCIM user',
  session: 'Session',
  visitor_enrollment_configuration: 'Visitor enrollment configuration',
  visitor_enrollment_context: 'Visitor enrollment context',
};

export function presentAction(event: AuditEvent): string {
  const label = actionLabels[event.action] ?? humanizeIdentifier(event.action);
  const role = event.resolvedMetadata.roleId;
  if ((event.action === 'account.role_assigned' || event.action === 'role.assigned') && role) {
    return `${label}: ${role}`;
  }
  return label;
}

export function presentActor(event: AuditEvent): string {
  if (event.actorDisplayName) return event.actorDisplayName;
  if (event.actorType === 'system') return 'System';
  if (event.actorType === 'unknown') return 'Unavailable actor';
  return event.actorAccountId ? `Unavailable user · ${shortID(event.actorAccountId)}` : 'Deleted user';
}

export function presentTarget(event: AuditEvent): string {
  const person = event.resolvedMetadata.personId;
  const openDay = event.resolvedMetadata.openDayId;
  if (event.resourceType === 'open_day_assignment' && (person || openDay)) {
    return [person, openDay && formatOpenDayLabel(openDay)].filter(Boolean).join(' · ');
  }
  if (event.resourceDisplayName) {
    return event.resourceType === 'open_day' ? formatOpenDayLabel(event.resourceDisplayName) : event.resourceDisplayName;
  }
  const type = resourceLabels[event.resourceType] ?? humanizeIdentifier(event.resourceType);
  return event.resourceId ? `${type} · ${shortID(event.resourceId)}` : type;
}

export function humanizeIdentifier(value: string): string {
  const text = value.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Unknown activity';
}

function shortID(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

function formatOpenDayLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
