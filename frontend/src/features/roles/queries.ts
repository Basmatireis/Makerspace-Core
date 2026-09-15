import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { Role } from '../../api/generated/models';
import { listPermissions } from '../../api/generated/permissions/permissions';
import { getRole, listRoles } from '../../api/generated/roles/roles';
import { listManagedDeviceTypes } from '../../api/generated/managed-devices/managed-devices';

export const roleKeys = {
  all: ['roles'] as const,
  lists: () => [...roleKeys.all, 'list'] as const,
  details: () => [...roleKeys.all, 'detail'] as const,
  detail: (roleId: string) => [...roleKeys.details(), roleId] as const,
  permissions: ['permissions'] as const,
  deviceTypes: ['managed-device-types'] as const,
};

export const fullRoleCatalogOptions = queryOptions({
  queryKey: [...roleKeys.lists(), 'catalog'] as const,
  queryFn: async ({ signal }) => {
    const roles: Role[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    do {
      const page = await listRoles(
        { limit: 100, ...(cursor ? { cursor } : {}) },
        { signal },
      );
      roles.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      if (cursor) {
        if (seenCursors.has(cursor)) {
          throw new Error('Role catalog returned a repeated cursor');
        }
        seenCursors.add(cursor);
      }
    } while (cursor);

    return roles;
  },
});

export function roleOptions(roleId: string) {
  return queryOptions({
    queryKey: roleKeys.detail(roleId),
    queryFn: ({ signal }) => getRole(roleId, { signal }),
  });
}

export const permissionListOptions = queryOptions({
  queryKey: roleKeys.permissions,
  queryFn: ({ signal }) => listPermissions({ signal }),
  staleTime: 5 * 60 * 1000,
});
export const deviceTypeListOptions = queryOptions({queryKey:roleKeys.deviceTypes,queryFn:({signal})=>listManagedDeviceTypes({signal}),staleTime:5*60*1000});

export async function refreshRoleData(queryClient: QueryClient, roleId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: roleKeys.lists() }),
    queryClient.invalidateQueries({ queryKey: roleKeys.detail(roleId) }),
  ]);
}
