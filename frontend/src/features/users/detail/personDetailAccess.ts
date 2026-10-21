import type { AccountSummary, Person } from '../../../api/generated/models';
import { canUpdatePerson, hasPermission, PermissionId } from '../../auth/permissions';
import type { useCurrentUser } from '../../auth/auth';

/** What the current user may do on a person's detail page. UX gating only; the backend enforces every permission. */
export function getPersonDetailAccess(
  currentUser: ReturnType<typeof useCurrentUser>,
  person: Person,
  account: AccountSummary | undefined,
) {
  const canEditPerson = canUpdatePerson(currentUser, person.id);
  const canReadMatriculation = hasPermission(currentUser, PermissionId.peoplereadmatriculation);
  const canEditMatriculation =
    canReadMatriculation && hasPermission(currentUser, PermissionId.peopleupdatematriculation);
  const canEditMemberSince = hasPermission(currentUser, PermissionId.peopleupdateall);
  const canReadAccounts = hasPermission(currentUser, PermissionId.accountsread);
  const canAssignRoles = hasPermission(currentUser, PermissionId.peoplerolesassign);
  const canReadRoles = hasPermission(currentUser, PermissionId.rolesread);
  const canReadMakerspaceStatus =
    hasPermission(currentUser, PermissionId.open_daysread_assignments) ||
    hasPermission(currentUser, PermissionId.laborordnungrequestsread);
  const canUpdateProfileImage =
    hasPermission(currentUser, PermissionId.peopleprofile_imageupdateall) ||
    (currentUser.person.id === person.id && hasPermission(currentUser, PermissionId.peopleprofile_imageupdateself));
  const canRemoveProfileImage =
    hasPermission(currentUser, PermissionId.peopleprofile_imageremoveall) ||
    (currentUser.person.id === person.id && hasPermission(currentUser, PermissionId.peopleprofile_imageremoveself));
  const canEditProfileImage = canUpdateProfileImage || Boolean(person.profileImage && canRemoveProfileImage);
  const canEditLoginEmail = Boolean(account) && hasPermission(currentUser, PermissionId.accountslogin_emailupdate);
  const canCreateAccount = person.account === null && hasPermission(currentUser, PermissionId.accountscreate);
  const canDeletePerson =
    hasPermission(currentUser, PermissionId.peopledelete) &&
    (hasPermission(currentUser, PermissionId.accountsdelete) || (canReadAccounts && person.account === null));
  const canDisableAccount = account?.status === 'enabled' && hasPermission(currentUser, PermissionId.accountsdisable);
  const canDeleteAccount = Boolean(account) && hasPermission(currentUser, PermissionId.accountsdelete);
  const canAssignRole = canAssignRoles && canReadRoles;
  // Emergency administrator password setting remains an API-only compatibility
  // operation; routine UI workflows use recipient-owned invitations and resets.
  const canSetPassword = false;
  const passwordIdentity = account?.authIdentities.find((identity) => identity.kind === 'password');
  const pinIdentity = account?.authIdentities.find((identity) => identity.kind === 'pin');
  const oidcIdentities = account?.authIdentities.filter((identity) => identity.kind === 'oidc') ?? [];
  const hasUsableAuthenticationMethod = account?.authIdentities.some((identity) => identity.usable) ?? false;
  // Accounts provisioned without an email (phone-only visitors, older accounts) need one set by an administrator.
  const missingLoginEmail = Boolean(account) && !passwordIdentity;
  const canIssuePasswordReset =
    Boolean(passwordIdentity) &&
    account?.passwordStatus === 'active' &&
    hasPermission(currentUser, PermissionId.accountspasswordreset);
  const canInvite =
    Boolean(passwordIdentity) &&
    account?.passwordStatus !== 'active' &&
    hasPermission(currentUser, PermissionId.accountspasswordenrollall);
  const canConfigurePIN =
    Boolean(account) &&
    (pinIdentity
      ? hasPermission(currentUser, PermissionId.accountspinreset)
      : hasPermission(currentUser, PermissionId.accountspinenrollall));
  const canRemovePasswordIdentity =
    Boolean(passwordIdentity) && hasPermission(currentUser, PermissionId.accountspasswordremoveall);
  const canRemovePINIdentity = Boolean(pinIdentity) && hasPermission(currentUser, PermissionId.accountspinremoveall);
  const canRemoveOIDCIdentity = hasPermission(currentUser, PermissionId.identitiesoidcunlinkall);
  const hasAccountActions = canEditLoginEmail || canCreateAccount || canAssignRole;
  const hasCredentialActions = canSetPassword || canIssuePasswordReset || canInvite || canConfigurePIN;
  const hasPersonActions =
    canEditPerson ||
    canEditLoginEmail ||
    canCreateAccount ||
    canAssignRole ||
    canSetPassword ||
    canIssuePasswordReset ||
    canInvite ||
    canConfigurePIN;
  return {
    canEditPerson,
    canReadMatriculation,
    canEditMatriculation,
    canEditMemberSince,
    canReadAccounts,
    canReadRoles,
    canReadMakerspaceStatus,
    canUpdateProfileImage,
    canRemoveProfileImage,
    canEditProfileImage,
    canEditLoginEmail,
    missingLoginEmail,
    canCreateAccount,
    canDeletePerson,
    canDisableAccount,
    canDeleteAccount,
    canAssignRole,
    canSetPassword,
    passwordIdentity,
    pinIdentity,
    oidcIdentities,
    hasUsableAuthenticationMethod,
    canIssuePasswordReset,
    canInvite,
    canConfigurePIN,
    canRemovePasswordIdentity,
    canRemovePINIdentity,
    canRemoveOIDCIdentity,
    canEnableAccount: hasPermission(currentUser, PermissionId.accountsenable),
    hasAccountActions,
    hasCredentialActions,
    hasPersonActions,
  };
}
