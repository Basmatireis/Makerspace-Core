import type { PermissionIdType } from '../../auth/permissions';
import { hasPermission } from '../../auth/permissions';
import { useCurrentUser } from '../../auth/auth';

/**
 * `const can = useCan(); can('machine_jobs.edit')`. Permission checks in ported screens stay one-to-one with the
 * prototype. This is UX gating only; the backend enforces every permission.
 */
export function useCan() {
  const currentUser = useCurrentUser();
  return (permission: PermissionIdType) => hasPermission(currentUser, permission);
}
