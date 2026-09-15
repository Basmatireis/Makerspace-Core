import type {
  Account,
  CurrentUser,
  PermissionId,
  Person,
  Role,
} from '../api/generated/models';

export const fixturePersonId = '0192f6f8-743e-7c77-a349-cd07c3e8a901';
export const fixtureAccountId = '0192f6f8-743e-7c77-a349-cd07c3e8a902';
export const fixtureRoleId = '0192f6f8-743e-7c77-a349-cd07c3e8a903';
export const otherPersonId = '0192f6f8-743e-7c77-a349-cd07c3e8a904';
export const otherAccountId = '0192f6f8-743e-7c77-a349-cd07c3e8a905';

export function roleFixture(overrides: Partial<Role> = {}): Role {
  return {
    id: fixtureRoleId,
    name: 'Workshop supervisors',
    description: 'Routine workshop access.',
    systemKey: null,
    permissionGrants: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

export function accountFixture(overrides: Partial<Account> = {}): Account {
  return {
    id: otherAccountId,
    personId: otherPersonId,
    loginEmail: 'grace.login@example.test',
    status: 'enabled',
    passwordStatus: 'active',
    roles: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

export function personFixture(overrides: Partial<Person> = {}): Person {
  return {
    id: otherPersonId,
    firstName: 'Grace',
    lastName: 'Hopper',
    email: 'grace@example.test',
    phone: null,
    matriculationNumber: 'M-0042',
    account: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

export function currentUserFixture(
  permissions: PermissionId[] = [],
  master = false,
): CurrentUser {
  const personId = fixturePersonId;
  const accountId = fixtureAccountId;
  return {
    person: {
      id: personId,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.test',
      phone: null,
      matriculationNumber: null,
      account: {
        id: accountId,
        personId,
        loginEmail: 'ada@example.test',
        status: 'enabled',
        passwordStatus: 'active',
        roles: master
          ? [{ id: fixtureRoleId, name: 'Master', systemKey: 'master' }]
          : [],
        version: 1,
      },
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 1,
    },
    account: {
      id: accountId,
      personId,
      loginEmail: 'ada@example.test',
      status: 'enabled',
      passwordStatus: 'active',
      roles: master
        ? [{ id: fixtureRoleId, name: 'Master', systemKey: 'master' }]
        : [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      version: 1,
    },
    permissions,
    managedDevice: null,
    delegablePermissionGrants: permissions.map((permissionId) => ({ permissionId, scope: 'everywhere', deviceTypeIds: [] })),
  };
}
