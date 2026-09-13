import { describe, expect, it } from 'vitest';
import type { Role } from '../../api/generated/models';
import { PermissionId } from '../../api/generated/models';
import { currentUserFixture } from '../../test/fixtures';
import { canManageRoleMembership } from './permissions';

const role = (permissionIds: Role['permissionIds'], systemKey: Role['systemKey'] = null) => ({
  permissionIds,
  systemKey,
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
});
