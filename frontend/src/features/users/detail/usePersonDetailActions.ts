import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import {
  createPersonAccount,
  deleteAccount,
  disableAccount,
  enableAccount,
  issueAccountInvitation,
  issueAccountPinEnrollment,
  issueAccountPasswordReset,
  removeAccountAuthIdentity,
  setAccountPin,
  setAccountPassword,
  updateAccountLoginEmail,
} from '../../../api/generated/accounts/accounts';
import type {
  AccountSummary,
  AuthIdentitySummary,
  Person,
  Role,
  UpdatePersonRequest,
} from '../../../api/generated/models';
import { assignPersonRole, deletePerson, removePersonRole, updatePerson } from '../../../api/generated/people/people';
import { useSecretMutation } from '../../../api/use-secret-mutation';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { authQueryKey, useCurrentUser } from '../../auth/auth';
import { canManageRoleMembership } from '../../auth/permissions';
import { fullRoleCatalogOptions } from '../../roles/queries';
import { deletionFailureReasons } from '../deletionErrors';
import { type PersonFormValues, toPersonPatch } from '../PersonForm';
import { peopleKeys, refreshPersonData } from '../queries';
import type { getPersonDetailAccess } from './personDetailAccess';
import type { AccountEmailForm, AccountPasswordForm, AccountPINForm, ConfirmKind } from './types';

/** Dialog state, forms and mutations of the person detail page. */
export function usePersonDetailActions({
  person,
  account,
  access,
}: {
  person: Person;
  account: AccountSummary | undefined;
  access: ReturnType<typeof getPersonDetailAccess>;
}) {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { passwordIdentity, pinIdentity, canEditMatriculation, canReadRoles } = access;
  const [editingPerson, setEditingPerson] = useState(false);
  const [loginEmailModalOpen, setLoginEmailModalOpen] = useState(false);
  const [assignRoleOpen, setAssignRoleOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [pinModalOpen, setPINModalOpen] = useState(false);
  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null);
  const [authIdentityToRemove, setAuthIdentityToRemove] = useState<AuthIdentitySummary | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [roleToRemove, setRoleToRemove] = useState<Person['roles'][number] | null>(null);
  const [resetSent, setResetSent] = useState(false);
  const [resetExpiresAt, setResetExpiresAt] = useState<string | null>(null);
  const [manualSetupUrl, setManualSetupUrl] = useState<string | null>(null);
  const [resetPending, setResetPending] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);

  const clearResetIssue = () => {
    setResetSent(false);
    setResetExpiresAt(null);
    setManualSetupUrl(null);
  };

  const personForm = useForm<PersonFormValues>({
    defaultValues: {
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email ?? '',
      phone: person.phone ?? '',
      matriculationNumber: person.matriculationNumber ?? '',
    },
  });
  const accountCreateForm = useForm<AccountEmailForm>({ defaultValues: { loginEmail: '' } });
  const accountEmailForm = useForm<AccountEmailForm>({
    defaultValues: { loginEmail: passwordIdentity?.displayIdentifier ?? '' },
  });
  const accountPasswordForm = useForm<AccountPasswordForm>({ defaultValues: { newPassword: '', confirmPassword: '' } });
  const accountPINForm = useForm<AccountPINForm>({
    defaultValues: { loginName: pinIdentity?.displayIdentifier ?? '', pin: '', confirmPIN: '' },
  });

  useEffect(() => {
    accountEmailForm.reset({ loginEmail: passwordIdentity?.displayIdentifier ?? '' });
  }, [passwordIdentity?.displayIdentifier, accountEmailForm]);

  useEffect(() => {
    accountPINForm.reset({ loginName: pinIdentity?.displayIdentifier ?? '', pin: '', confirmPIN: '' });
  }, [pinIdentity?.displayIdentifier, accountPINForm]);

  const refresh = async () => {
    await refreshPersonData(queryClient, person.id);
  };
  const personMutation = useMutation({
    mutationFn: (request: UpdatePersonRequest) => updatePerson(person.id, request),
    onSuccess: async (updated) => {
      queryClient.setQueryData(peopleKeys.detail(person.id), updated);
      await queryClient.invalidateQueries({ queryKey: peopleKeys.lists() });
      setEditingPerson(false);
    },
  });
  const createAccountMutation = useMutation({
    mutationFn: ({ loginEmail }: AccountEmailForm) => {
      const normalizedLoginEmail = loginEmail.trim();
      return createPersonAccount(person.id, {
        loginEmail: normalizedLoginEmail || null,
        expectedVersion: person.version,
      });
    },
    onSuccess: async () => {
      setCreateAccountOpen(false);
      accountCreateForm.reset({ loginEmail: '' });
      await refresh();
    },
  });
  const emailMutation = useMutation({
    mutationFn: ({ loginEmail }: AccountEmailForm) =>
      updateAccountLoginEmail(account!.id, { loginEmail: loginEmail.trim(), expectedVersion: account!.version }),
    onSuccess: async () => {
      setLoginEmailModalOpen(false);
      await refresh();
    },
  });
  const pinMutation = useSecretMutation(
    ({ loginName, pin }: AccountPINForm) =>
      setAccountPin(account!.id, { loginName: loginName.trim(), pin, expectedVersion: account!.version }),
    {
      onSuccess: async () => {
        accountPINForm.reset({ loginName: '', pin: '', confirmPIN: '' });
        setPINModalOpen(false);
        await refresh();
      },
    },
  );
  const passwordMutation = useSecretMutation(
    ({ newPassword }: AccountPasswordForm) =>
      setAccountPassword(account!.id, { newPassword, expectedVersion: account!.version }),
    {
      onSuccess: async () => {
        accountPasswordForm.reset();
        clearResetIssue();
        setPasswordModalOpen(false);
        await refresh();
      },
    },
  );
  const enableMutation = useMutation({
    mutationFn: () => enableAccount(account!.id, { expectedVersion: account!.version }),
    onSuccess: refresh,
  });
  const disableMutation = useMutation({
    mutationFn: () => disableAccount(account!.id, { expectedVersion: account!.version }),
    onSuccess: async () => {
      setConfirmKind(null);
      await refresh();
    },
  });
  const deleteAccountMutation = useMutation({
    mutationFn: () => deleteAccount(account!.id, { expectedVersion: account!.version }),
    onSuccess: async () => {
      setConfirmKind(null);
      clearResetIssue();
      queryClient.removeQueries({ queryKey: ['accounts', 'detail', account!.id] });
      await refresh();
    },
  });
  const removeAuthIdentityMutation = useMutation({
    mutationFn: (identity: AuthIdentitySummary) =>
      removeAccountAuthIdentity(account!.id, identity.id, { expectedVersion: account!.version }),
    onSuccess: async () => {
      setConfirmKind(null);
      setAuthIdentityToRemove(null);
      await refresh();
      if (account?.id === currentUser.account.id) {
        await queryClient.invalidateQueries({ queryKey: authQueryKey });
      }
    },
  });
  const deletePersonMutation = useMutation({
    mutationFn: () => deletePerson(person.id, { expectedVersion: person.version }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: peopleKeys.detail(person.id) });
      await queryClient.invalidateQueries({ queryKey: peopleKeys.lists() });
      navigate('/people', { replace: true });
    },
  });
  const roleMutation = useMutation({
    mutationFn: ({ roleId, remove }: { roleId: string; remove: boolean }) =>
      remove
        ? removePersonRole(person.id, roleId, { expectedVersion: person.version })
        : assignPersonRole(person.id, roleId, { expectedVersion: person.version }),
    onSuccess: async () => {
      setSelectedRole(null);
      setRoleToRemove(null);
      setAssignRoleOpen(false);
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: authQueryKey })]);
    },
  });

  const rolesQuery = useQuery({ ...fullRoleCatalogOptions, enabled: canReadRoles });
  const rolesById = new Map((rolesQuery.data ?? []).map((role) => [role.id, role]));
  const assignedRoleIds = new Set(person.roles.map((role) => role.id));
  const assignableRoles = (rolesQuery.data ?? []).filter(
    (role) => !assignedRoleIds.has(role.id) && canManageRoleMembership(currentUser, role),
  );

  const submitPerson = personForm.handleSubmit(async (values) => {
    try {
      await personMutation.mutateAsync(
        toPersonPatch(values, personForm.formState.dirtyFields, person.version, canEditMatriculation),
      );
    } catch {
      /* rendered below */
    }
  });
  const submitCreateAccount = accountCreateForm.handleSubmit(async (values) => {
    try {
      await createAccountMutation.mutateAsync(values);
    } catch {
      /* rendered in modal */
    }
  });
  const submitEmail = accountEmailForm.handleSubmit(async (values) => {
    try {
      await emailMutation.mutateAsync(values);
    } catch {
      /* rendered below */
    }
  });
  const submitPassword = accountPasswordForm.handleSubmit(async (values) => {
    try {
      await passwordMutation.mutateAsync(values);
    } catch {
      /* rendered in modal */
    }
  });
  const submitPIN = accountPINForm.handleSubmit(async (values) => {
    try {
      await pinMutation.mutateAsync(values);
    } catch {
      /* rendered in modal */
    }
  });

  const confirmAction = async () => {
    try {
      if (confirmKind === 'delete-person') await deletePersonMutation.mutateAsync();
      if (confirmKind === 'delete-account') await deleteAccountMutation.mutateAsync();
      if (confirmKind === 'disable-account') await disableMutation.mutateAsync();
      if (confirmKind === 'remove-auth-method' && authIdentityToRemove) {
        await removeAuthIdentityMutation.mutateAsync(authIdentityToRemove);
      }
      if (confirmKind === 'reset-password' && account) {
        setResetPending(true);
        setResetFailed(false);
        const issue = await issueAccountPasswordReset(account.id, { expectedVersion: account.version });
        setConfirmKind(null);
        setResetSent(true);
        setResetExpiresAt(issue.expiresAt);
        setManualSetupUrl(issue.setupUrl ?? null);
        queryClient.setQueryData(['accounts', 'detail', issue.account.id], issue.account);
        await refresh();
      }
      if (confirmKind === 'invite' && account) {
        setResetPending(true);
        setResetFailed(false);
        const issue = await issueAccountInvitation(account.id, { expectedVersion: account.version });
        setConfirmKind(null);
        setResetSent(true);
        setResetExpiresAt(issue.expiresAt);
        setManualSetupUrl(issue.setupUrl ?? null);
        queryClient.setQueryData(['accounts', 'detail', issue.account.id], issue.account);
        await refresh();
      }
      if (confirmKind === 'pin-setup' && account) {
        setResetPending(true);
        setResetFailed(false);
        const issue = await issueAccountPinEnrollment(account.id, { expectedVersion: account.version });
        setConfirmKind(null);
        setResetSent(true);
        setResetExpiresAt(issue.expiresAt);
        setManualSetupUrl(issue.setupUrl ?? null);
        queryClient.setQueryData(['accounts', 'detail', issue.account.id], issue.account);
        await refresh();
      }
    } catch {
      if (confirmKind === 'reset-password' || confirmKind === 'invite' || confirmKind === 'pin-setup')
        setResetFailed(true);
    } finally {
      setResetPending(false);
    }
  };

  const confirmation = {
    'delete-person': [
      'Delete person permanently?',
      'This permanently deletes the person and, if present, their account, authentication methods, and role assignments. Operational links are detached and assignment identity data is scrubbed. Existing order customer and external-invoice recipient snapshots remain as financial records. This cannot be undone.',
      'Delete person',
    ],
    'delete-account': [
      'Delete account permanently?',
      'The login account, authentication methods, and sessions are permanently removed. The person record and assigned roles remain.',
      'Delete account',
    ],
    'disable-account': [
      'Disable this account?',
      'The user will be signed out and will not be able to sign in. The person record, assigned roles, and authentication methods remain.',
      'Disable account',
    ],
    'reset-password': [
      'Send a password reset code?',
      'A one-time code will be emailed. The current password remains active until the recipient completes the reset.',
      'Send reset code',
    ],
    invite: [
      'Send an account invitation?',
      'A one-time setup code will be emailed. Completing it verifies the email, sets the password, and enables an account that was not explicitly disabled.',
      'Send invitation',
    ],
    'pin-setup': [
      pinIdentity ? 'Create a PIN reset link?' : 'Create a PIN setup link?',
      'A one-time setup link will be emailed when a contact address and mail delivery are available. Otherwise, copy the returned link and deliver it through a trusted channel.',
      pinIdentity ? 'Create PIN reset link' : 'Create PIN setup link',
    ],
  } as const;
  const selectedConfirmation =
    confirmKind === 'remove-auth-method'
      ? authIdentityToRemove
        ? ([
            `Remove ${authenticationMethodName(authIdentityToRemove.kind)}?`,
            'This removes the login method and signs out existing account sessions. The account remains active or inactive independently.',
            'Remove method',
          ] as const)
        : null
      : confirmKind
        ? confirmation[confirmKind]
        : null;
  const confirmationPending =
    resetPending ||
    deletePersonMutation.isPending ||
    deleteAccountMutation.isPending ||
    disableMutation.isPending ||
    removeAuthIdentityMutation.isPending;
  const closeConfirmation = useLatestCallback(() => {
    if (!confirmationPending) {
      setConfirmKind(null);
      setAuthIdentityToRemove(null);
      removeAuthIdentityMutation.reset();
    }
    return false;
  });
  const confirmationErrors: string[] =
    confirmKind === 'delete-person' && deletePersonMutation.isError
      ? deletionFailureReasons(deletePersonMutation.error, 'person')
      : confirmKind === 'delete-account' && deleteAccountMutation.isError
        ? deletionFailureReasons(deleteAccountMutation.error, 'account')
        : confirmKind === 'disable-account' && disableMutation.isError
          ? ['The account may have changed or cannot be disabled. Reload and try again.']
          : [];
  const mutationError =
    personMutation.isError ||
    createAccountMutation.isError ||
    emailMutation.isError ||
    passwordMutation.isError ||
    pinMutation.isError ||
    enableMutation.isError ||
    disableMutation.isError ||
    deleteAccountMutation.isError ||
    removeAuthIdentityMutation.isError ||
    deletePersonMutation.isError ||
    roleMutation.isError ||
    resetFailed;

  return {
    editingPerson,
    setEditingPerson,
    loginEmailModalOpen,
    setLoginEmailModalOpen,
    assignRoleOpen,
    setAssignRoleOpen,
    passwordModalOpen,
    setPasswordModalOpen,
    pinModalOpen,
    setPINModalOpen,
    createAccountOpen,
    setCreateAccountOpen,
    confirmKind,
    setConfirmKind,
    authIdentityToRemove,
    setAuthIdentityToRemove,
    selectedRole,
    setSelectedRole,
    roleToRemove,
    setRoleToRemove,
    resetSent,
    resetExpiresAt,
    manualSetupUrl,
    resetFailed,
    clearResetIssue,
    personForm,
    accountCreateForm,
    accountEmailForm,
    accountPasswordForm,
    accountPINForm,
    personMutation,
    createAccountMutation,
    emailMutation,
    pinMutation,
    passwordMutation,
    enableMutation,
    removeAuthIdentityMutation,
    roleMutation,
    rolesQuery,
    rolesById,
    assignableRoles,
    submitPerson,
    submitCreateAccount,
    submitEmail,
    submitPassword,
    submitPIN,
    confirmAction,
    selectedConfirmation,
    confirmationPending,
    closeConfirmation,
    confirmationErrors,
    mutationError,
  };
}

export type PersonDetailActions = ReturnType<typeof usePersonDetailActions>;

function authenticationMethodName(kind: AuthIdentitySummary['kind']) {
  if (kind === 'password') return 'local password';
  if (kind === 'pin') return 'username and PIN';
  return 'OIDC identity';
}
