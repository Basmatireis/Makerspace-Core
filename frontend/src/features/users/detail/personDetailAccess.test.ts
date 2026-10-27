import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../../api/generated/models';
import { accountFixture, currentUserFixture, personFixture } from '../../../test/fixtures';
import { getPersonDetailAccess } from './personDetailAccess';

const access = (permissions: PermissionId[], account = accountFixture()) =>
  getPersonDetailAccess(currentUserFixture(permissions), personFixture({ account }), account);

describe('person detail password and email actions', () => {
  it('offers password setting only with accounts.password.set and an account', () => {
    expect(access([PermissionId.accountspasswordset]).canSetPassword).toBe(true);
    expect(access([PermissionId.accountsread]).canSetPassword).toBe(false);
    const person = personFixture({ account: null });
    expect(
      getPersonDetailAccess(currentUserFixture([PermissionId.accountspasswordset]), person, undefined).canSetPassword,
    ).toBe(false);
  });

  it('does not depend on mail delivery: reset and invitation are separate permissions', () => {
    const result = access([PermissionId.accountspasswordset, PermissionId.accountslogin_emailupdate]);
    expect(result.canSetPassword).toBe(true);
    expect(result.canEditLoginEmail).toBe(true);
    expect(result.canIssuePasswordReset).toBe(false);
    expect(result.canInvite).toBe(false);
  });

  it('needs the login-email permission to set a first password on an account without a login email', () => {
    const noEmail = accountFixture({ loginEmail: null, passwordStatus: 'not_set', authIdentities: [] });
    expect(access([PermissionId.accountspasswordset], noEmail).canSetPassword).toBe(false);
    expect(
      access([PermissionId.accountspasswordset, PermissionId.accountslogin_emailupdate], noEmail).canSetPassword,
    ).toBe(true);
  });
});
