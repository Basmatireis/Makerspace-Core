import { describe, expect, it } from 'vitest';
import type { PermissionGrant, Role } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { currentUserFixture } from '../../test/fixtures';
import { canManageRoleMembership } from './permissions';

const role = (permissionIds: PermissionId[], systemKey: Role['systemKey'] = null) => ({
  permissionGrants: permissionIds.map((permissionId) => ({
    permissionId,
    scope: 'everywhere' as const,
    deviceTypeIds: [],
  })),
  systemKey,
});

const scopedRole = (permissionGrants: PermissionGrant[]) => ({
  permissionGrants,
  systemKey: null,
});

describe('role membership authorization UX', () => {
  it('requires the role-assignment permission', () => {
    const currentUser = currentUserFixture([PermissionId.peoplereadall]);

    expect(
      canManageRoleMembership(currentUser, role([PermissionId.peoplereadall])),
    ).toBe(false);
  });

  it('allows a non-master actor only roles within their permission subset', () => {
    const currentUser = currentUserFixture([
      PermissionId.accountsrolesassign,
      PermissionId.peoplereadall,
    ]);

    expect(
      canManageRoleMembership(currentUser, role([PermissionId.peoplereadall])),
    ).toBe(true);
    expect(
      canManageRoleMembership(currentUser, role([PermissionId.rolesmanage])),
    ).toBe(false);
    expect(
      canManageRoleMembership(currentUser, role([], 'master')),
    ).toBe(false);
  });

  it('allows a master actor to manage every role', () => {
    const currentUser = currentUserFixture(
      [PermissionId.accountsrolesassign],
      true,
    );

    expect(
      canManageRoleMembership(currentUser, role([PermissionId.rolesmanage], 'master')),
    ).toBe(true);
  });

  it('uses the device-scope subset lattice for role assignment', () => {
    const reception = '0192f6f8-743e-7c77-a349-cd07c3e8a920';
    const workshop = '0192f6f8-743e-7c77-a349-cd07c3e8a921';
    const currentUser = currentUserFixture([
      PermissionId.accountsrolesassign,
      PermissionId.peoplereadall,
    ]);
    currentUser.delegablePermissionGrants = [
      { permissionId: PermissionId.accountsrolesassign, scope: 'everywhere', deviceTypeIds: [] },
      { permissionId: PermissionId.peoplereadall, scope: 'selectedDeviceTypes', deviceTypeIds: [reception] },
    ];

    expect(canManageRoleMembership(currentUser, scopedRole([{
      permissionId: PermissionId.peoplereadall,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: [reception],
    }]))).toBe(true);
    expect(canManageRoleMembership(currentUser, scopedRole([{
      permissionId: PermissionId.peoplereadall,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: [workshop],
    }]))).toBe(false);
    expect(canManageRoleMembership(currentUser, scopedRole([{
      permissionId: PermissionId.peoplereadall,
      scope: 'anyManagedDevice',
      deviceTypeIds: [],
    }]))).toBe(false);
  });
});
