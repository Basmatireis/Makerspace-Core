import { describe, expect, it } from 'vitest';
import type { PermissionGrant, Role } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { currentUserFixture } from '../../test/fixtures';
import {
  canAccessSettings,
  canLookupJobParties,
  canManageRoleMembership,
  hasAnyPermission,
  hasPermission,
  isPendingPermission,
  permissionGrantsValid,
} from './permissions';

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

describe('billing-party and operator lookup authorization UX', () => {
  it.each([PermissionId.ordersread, PermissionId.machine_jobscreate, PermissionId.organizationsread])(
    'allows the backend lookup grant %s independently',
    (permission) => {
      expect(canLookupJobParties(currentUserFixture([permission]))).toBe(true);
    },
  );

  it.each([
    PermissionId.machine_jobsread,
    PermissionId.machine_jobsedit,
    PermissionId.organizationsmanage,
    PermissionId.peoplereadall,
  ])('does not infer lookup access from %s', (permission) => {
    expect(canLookupJobParties(currentUserFixture([permission]))).toBe(false);
  });
});

describe('settings navigation', () => {
  it('excludes promoted People and Audit permissions', () => {
    expect(canAccessSettings(currentUserFixture([PermissionId.peoplereadall]))).toBe(false);
    expect(canAccessSettings(currentUserFixture([PermissionId.supervisor_dashboardread]))).toBe(false);
    expect(canAccessSettings(currentUserFixture([PermissionId.auditread]))).toBe(false);
  });

  it('admits invoicing and configuration transfer but not pricing or the Directory-owned organizations', () => {
    expect(canAccessSettings(currentUserFixture([PermissionId.organizationsread]))).toBe(false);
    expect(canAccessSettings(currentUserFixture([PermissionId.pricingread]))).toBe(false);
    expect(canAccessSettings(currentUserFixture([PermissionId.invoicingsettingsmanage]))).toBe(true);
    expect(canAccessSettings(currentUserFixture([PermissionId.configurationexport]))).toBe(true);
    expect(canAccessSettings(currentUserFixture([PermissionId.machinesread]))).toBe(false);
    expect(canAccessSettings(currentUserFixture([PermissionId.organizationsmanage, PermissionId.pricingmanage]))).toBe(
      false,
    );
  });
});

describe('role membership authorization UX', () => {
  it('handles legacy null device lists without crashing while preserving scope rules', () => {
    const legacyEverywhere = {
      permissionId: PermissionId.peoplereadall,
      scope: 'everywhere',
      deviceTypeIds: null,
      minimumAssurance: 'normal',
    } as unknown as PermissionGrant;
    const legacyManaged = {
      permissionId: PermissionId.peopleupdateall,
      scope: 'anyManagedDevice',
      deviceTypeIds: null,
      minimumAssurance: 'strong',
    } as unknown as PermissionGrant;
    const invalidSelected = {
      permissionId: PermissionId.rolesread,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: null,
      minimumAssurance: 'low',
    } as unknown as PermissionGrant;
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
    expect(permissionGrantsValid([base, { ...base, minimumAssurance: 'strong', deviceTypeIds: [workshop] }])).toBe(
      true,
    );
  });
  it('requires the role-assignment permission', () => {
    const currentUser = currentUserFixture([PermissionId.peoplereadall]);

    expect(canManageRoleMembership(currentUser, role([PermissionId.peoplereadall]))).toBe(false);
  });

  it('allows a non-master actor only roles within their permission subset', () => {
    const currentUser = currentUserFixture([PermissionId.peoplerolesassign, PermissionId.peoplereadall]);

    expect(canManageRoleMembership(currentUser, role([PermissionId.peoplereadall]))).toBe(true);
    expect(canManageRoleMembership(currentUser, role([PermissionId.rolesmanage]))).toBe(false);
    expect(canManageRoleMembership(currentUser, role([], 'master'))).toBe(false);
  });

  it('allows a master actor to manage every role', () => {
    const currentUser = currentUserFixture([PermissionId.peoplerolesassign], true);

    expect(canManageRoleMembership(currentUser, role([PermissionId.rolesmanage], 'master'))).toBe(true);
  });

  it('uses the device-scope subset lattice for role assignment', () => {
    const reception = '0192f6f8-743e-7c77-a349-cd07c3e8a920';
    const workshop = '0192f6f8-743e-7c77-a349-cd07c3e8a921';
    const currentUser = currentUserFixture([PermissionId.peoplerolesassign, PermissionId.peoplereadall]);
    currentUser.delegablePermissionGrants = [
      { permissionId: PermissionId.peoplerolesassign, scope: 'everywhere', deviceTypeIds: [], minimumAssurance: 'low' },
      {
        permissionId: PermissionId.peoplereadall,
        scope: 'selectedDeviceTypes',
        deviceTypeIds: [reception],
        minimumAssurance: 'low',
      },
    ];

    expect(
      canManageRoleMembership(
        currentUser,
        scopedRole([
          {
            permissionId: PermissionId.peoplereadall,
            scope: 'selectedDeviceTypes',
            deviceTypeIds: [reception],
            minimumAssurance: 'low',
          },
        ]),
      ),
    ).toBe(true);
    expect(
      canManageRoleMembership(
        currentUser,
        scopedRole([
          {
            permissionId: PermissionId.peoplereadall,
            scope: 'selectedDeviceTypes',
            deviceTypeIds: [workshop],
            minimumAssurance: 'low',
          },
        ]),
      ),
    ).toBe(false);
    expect(
      canManageRoleMembership(
        currentUser,
        scopedRole([
          {
            permissionId: PermissionId.peoplereadall,
            scope: 'anyManagedDevice',
            deviceTypeIds: [],
            minimumAssurance: 'low',
          },
        ]),
      ),
    ).toBe(false);
  });

  it('combines selected-type grants and enforces the assurance partial order', () => {
    const reception = '0192f6f8-743e-7c77-a349-cd07c3e8a920';
    const workshop = '0192f6f8-743e-7c77-a349-cd07c3e8a921';
    const currentUser = currentUserFixture([PermissionId.peoplerolesassign]);
    currentUser.delegablePermissionGrants = [reception, workshop].map((id) => ({
      permissionId: PermissionId.peoplereadall,
      scope: 'selectedDeviceTypes',
      deviceTypeIds: [id],
      minimumAssurance: 'normal',
    }));

    expect(
      canManageRoleMembership(
        currentUser,
        scopedRole([
          {
            permissionId: PermissionId.peoplereadall,
            scope: 'selectedDeviceTypes',
            deviceTypeIds: [reception, workshop],
            minimumAssurance: 'strong',
          },
        ]),
      ),
    ).toBe(true);
    expect(
      canManageRoleMembership(
        currentUser,
        scopedRole([
          {
            permissionId: PermissionId.peoplereadall,
            scope: 'selectedDeviceTypes',
            deviceTypeIds: [reception],
            minimumAssurance: 'low',
          },
        ]),
      ),
    ).toBe(false);
  });
});

describe('permissions withheld until a fresh sign-in', () => {
  it('count as held for the UI, so pages and controls stay visible and the API asks on use', () => {
    const user = currentUserFixture([PermissionId.rolesread]);
    user.authentication.reauthenticationRequired = [
      { permissionId: PermissionId.brandingmanage, requiredAssurance: 'normal', withinMinutes: 10 },
    ];
    expect(hasPermission(user, PermissionId.brandingmanage)).toBe(true);
    expect(isPendingPermission(user, PermissionId.brandingmanage)).toBe(true);
    expect(hasAnyPermission(user, [PermissionId.mailmanage, PermissionId.brandingmanage])).toBe(true);
    expect(hasPermission(user, PermissionId.mailmanage)).toBe(false);
    expect(isPendingPermission(user, PermissionId.rolesread)).toBe(false);
  });
});
