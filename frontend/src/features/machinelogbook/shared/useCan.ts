import type { PermissionIdType } from '../../auth/permissions';
import { hasPermission } from '../../auth/permissions';
import { useCurrentUser } from '../../auth/auth';

/**
 * `const can = useCan(); can('machine_jobs.edit')`. Permission checks in the screens mirror the backend permissions
 * one-to-one. This is UX gating only; the backend enforces every permission.
 */
export function useCan() {
  const currentUser = useCurrentUser();
  return (permission: PermissionIdType) => hasPermission(currentUser, permission);
}
