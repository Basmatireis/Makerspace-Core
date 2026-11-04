import type { CurrentUser, PermissionId } from '../../api/generated/models';
import { currentUserFixture } from '../../test/fixtures';

/** The permissions the three demo areas (Workshop, Sales & payments, Open Days) need. */
export const demoPermissions = [
  'machines.read',
  'machine_jobs.read',
  'machine_jobs.create',
  'machine_jobs.edit',
  'inventory.read',
  'inventory.manage',
  'inventory.purchase',
  'orders.read',
  'orders.write',
  'orders.finalize',
  'payments.read',
  'payments.record',
  'payments.reverse',
  'pricing.read',
  'organizations.read',
  'people.read.all',
  'open_days.read',
  'open_days.read_assignments',
  'open_days.signup',
  'open_days.assign',
] as PermissionId[];

/** Test-only: a signed-in user for demo mode tests; `permissions` defaults to everything the demo needs. */
export const demoTestUser = (permissions: PermissionId[] = demoPermissions): CurrentUser =>
  currentUserFixture(permissions);
