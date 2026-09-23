import { describe, expect, it } from 'vitest';
import type { PermissionGrant, Role } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { currentUserFixture } from '../../test/fixtures';
import { canManageRoleMembership, permissionGrantsValid } from './permissions';

const role = (permissionIds: PermissionId[], systemKey: Role['systemKey'] = null) => ({
  permissionGrants: permissionIds.map((permissionId) => ({
    permissionId,
    scope: 'everywhere' as const,
    deviceTypeIds: [],
    minimumAssurance: 'low' as const,
  })),
  systemKey,
});

const scopedRole = (permissionGrants: PermissionGrant[]) => ({
  permissionGrants,
  systemKey: null,
});

describe('role membership authorization UX', () => {
  it('handles legacy null device lists without crashing while preserving scope rules', () => {
    const legacyEverywhere = { permissionId: PermissionId.peoplereadall, scope: 'everywhere', deviceTypeIds: null, minimumAssurance: 'normal' } as unknown as PermissionGrant;
    const legacyManaged = { permissionId: PermissionId.peopleupdateall, scope: 'anyManagedDevice', deviceTypeIds: null, minimumAssurance: 'strong' } as unknown as PermissionGrant;
    const invalidSelected = { permissionId: PermissionId.rolesread, scope: 'selectedDeviceTypes', deviceTypeIds: null, minimumAssurance: 'low' } as unknown as PermissionGrant;
    expect(permissionGrantsValid([legacyEverywhere, legacyManaged])).toBe(true);
    expect(permissionGrantsValid([invalidSelected])).toBe(false);
  });

  it('matches backend validation for duplicate rules and selected device types', () => {
    const reception = '0192f6f8-743e-7c77-a349-cd07c3e8a920';
    const workshop = '0192f6f8-743e-7c77-a349-cd07c3e8a921';
    const base: PermissionGrant = {
      permissionId: PermissionId.peoplereadall,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: [reception],
      minimumAssurance: 'normal',
    };

    expect(permissionGrantsValid([base, { ...base, deviceTypeIds: [workshop] }])).toBe(false);
    expect(permissionGrantsValid([{ ...base, deviceTypeIds: [reception, reception] }])).toBe(false);
    expect(permissionGrantsValid([{ ...base, deviceTypeIds: [] }])).toBe(false);
    expect(permissionGrantsValid([{ ...base, scope: 'everywhere', deviceTypeIds: [reception] }])).toBe(false);
    expect(permissionGrantsValid([base, { ...base, minimumAssurance: 'strong', deviceTypeIds: [workshop] }])).toBe(true);
  });
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
      { permissionId: PermissionId.accountsrolesassign, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' },
      { permissionId: PermissionId.peoplereadall, scope: 'selectedDeviceTypes', deviceTypeIds: [reception], minimumAssurance: 'low' },
    ];

    expect(canManageRoleMembership(currentUser, scopedRole([{
      permissionId: PermissionId.peoplereadall,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: [reception],
      minimumAssurance: 'low',
    }]))).toBe(true);
    expect(canManageRoleMembership(currentUser, scopedRole([{
      permissionId: PermissionId.peoplereadall,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: [workshop],
      minimumAssurance: 'low',
    }]))).toBe(false);
    expect(canManageRoleMembership(currentUser, scopedRole([{
      permissionId: PermissionId.peoplereadall,
      scope: 'anyManagedDevice',
      deviceTypeIds: [],
      minimumAssurance: 'low',
    }]))).toBe(false);
  });

  it('combines selected-type grants and enforces the assurance partial order', () => {
    const reception = '0192f6f8-743e-7c77-a349-cd07c3e8a920';
    const workshop = '0192f6f8-743e-7c77-a349-cd07c3e8a921';
    const currentUser = currentUserFixture([PermissionId.accountsrolesassign]);
    currentUser.delegablePermissionGrants = [reception, workshop].map((id) => ({
      permissionId: PermissionId.peoplereadall,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: [id],
      minimumAssurance: 'normal',
    }));

    expect(canManageRoleMembership(currentUser, scopedRole([{
      permissionId: PermissionId.peoplereadall,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: [reception, workshop],
      minimumAssurance: 'strong',
    }]))).toBe(true);
    expect(canManageRoleMembership(currentUser, scopedRole([{
      permissionId: PermissionId.peoplereadall,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: [reception],
      minimumAssurance: 'low',
    }]))).toBe(false);
  });
});
