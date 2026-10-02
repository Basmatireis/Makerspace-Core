import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Column,
  ComposedModal,
  CopyButton,
  DismissibleTag,
  Dropdown,
  Form,
  Grid,
  InlineNotification,
  MenuButton,
  MenuItem,
  MenuItemDivider,
  ModalBody,
  ModalFooter,
  ModalHeader,
  OverflowMenu,
  OverflowMenuItem,
  PasswordInput,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tag,
  TextInput,
  Tile,
} from '@carbon/react';
import { Edit, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  assignAccountRole,
  createPersonAccount,
  deleteAccount,
  disableAccount,
  enableAccount,
  issueAccountInvitation,
  issueAccountPinEnrollment,
  issueAccountPasswordReset,
  removeAccountAuthIdentity,
  removeAccountRole,
  setAccountPin,
  setAccountPassword,
  updateAccountLoginEmail,
} from '../../api/generated/accounts/accounts';
import type {
  AccountSummary,
  AuthIdentitySummary,
  LaborordnungStatus,
  Person,
  ProfileImage,
  Role,
  UpdatePersonRequest,
} from '../../api/generated/models';
import {
  deletePerson,
  deletePersonProfileImage,
  getPersonMakerspaceStatus,
  getPutPersonProfileImageUrl,
  updatePerson,
} from '../../api/generated/people/people';
import { apiFetch } from '../../api/http-client';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, FullPageLoading, InlineLoadingState } from '../../app/PageState';
import { authQueryKey, useCurrentUser } from '../auth/auth';
import {
  canManageRoleMembership,
  canUpdatePerson,
  hasPermission,
  PermissionId,
} from '../auth/permissions';
import { validatePasswordLength } from '../auth/password-validation';
import { fullRoleCatalogOptions } from '../roles/queries';
import {
  PersonFields,
  type PersonFormValues,
  toPersonPatch,
} from './PersonForm';
import { peopleKeys, personOptions, refreshPersonData } from './queries';
import { PersonAvatar } from './PersonAvatar';
import {
  AuthenticationMethod,
  DetailRow,
  DetailSection,
} from './PersonDetailComponents';
import { ProfilePictureEditor } from './ProfilePictureEditor';

type ConfirmKind = 'delete-person' | 'delete-account' | 'disable-account' | 'reset-password' | 'invite' | 'pin-setup' | 'remove-auth-method' | null;
type AccountEmailForm = { loginEmail: string };
type AccountPasswordForm = { newPassword: string; confirmPassword: string };
type AccountPINForm = { loginName: string; pin: string; confirmPIN: string };
type PersonDetailTab = 'overview' | 'personal-information' | 'account-access' | 'roles-permissions' | 'makerspace-status';

type PersonDetailTabOption = {
  key: PersonDetailTab;
  label: string;
};

const personDetailTabs: readonly PersonDetailTabOption[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'personal-information', label: 'Personal information' },
  { key: 'account-access', label: 'Account access' },
  { key: 'roles-permissions', label: 'Roles & permissions' },
  { key: 'makerspace-status', label: 'Makerspace status' },
];

function asAccount(value: Person['account']): AccountSummary | undefined {
  return value && typeof value === 'object' ? value : undefined;
}

export function UserDetailPage() {
  const { personId = '' } = useParams();
  const personQuery = useQuery(personOptions(personId));

  if (personQuery.isPending) return <FullPageLoading label="Loading person" />;
  if (personQuery.isError || !personQuery.data) {
    return (
      <ErrorState
        title="Unable to load person"
        message="The person may no longer exist or you may not have access."
        onRetry={() => void personQuery.refetch()}
      />
    );
  }

  return <UserDetailContent key={`${personQuery.data.id}-${personQuery.data.version}`} person={personQuery.data} />;
}

function UserDetailContent({ person }: { person: Person }) {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const accountSummary = asAccount(person.account);
  const account: AccountSummary | undefined = accountSummary;
  const [editingPerson, setEditingPerson] = useState(false);
  const [loginEmailModalOpen, setLoginEmailModalOpen] = useState(false);
  const [assignRoleOpen, setAssignRoleOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [pinModalOpen, setPINModalOpen] = useState(false);
  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null);
  const [authIdentityToRemove, setAuthIdentityToRemove] = useState<AuthIdentitySummary | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
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

  const canEditPerson = canUpdatePerson(currentUser, person.id);
  const canReadMatriculation = hasPermission(currentUser, PermissionId.peoplereadmatriculation);
  const canEditMatriculation = canReadMatriculation && hasPermission(currentUser, PermissionId.peopleupdatematriculation);
  const canReadAccounts = hasPermission(currentUser, PermissionId.accountsread);
  const canAssignRoles = hasPermission(currentUser, PermissionId.accountsrolesassign);
  const canReadRoles = hasPermission(currentUser, PermissionId.rolesread);
  const canReadMakerspaceStatus = hasPermission(currentUser, PermissionId.open_daysread_assignments) ||
    hasPermission(currentUser, PermissionId.laborordnungrequestsread);
  const makerspaceStatusQuery = useQuery({
    queryKey: [...peopleKeys.detail(person.id), 'makerspace-status'],
    queryFn: ({ signal }) => getPersonMakerspaceStatus(person.id, { signal }),
    enabled: canReadMakerspaceStatus,
  });
  const canUpdateProfileImage = hasPermission(currentUser, PermissionId.peopleprofile_imageupdateall) ||
    (currentUser.person.id === person.id && hasPermission(currentUser, PermissionId.peopleprofile_imageupdateself));
  const canRemoveProfileImage = hasPermission(currentUser, PermissionId.peopleprofile_imageremoveall) ||
    (currentUser.person.id === person.id && hasPermission(currentUser, PermissionId.peopleprofile_imageremoveself));
  const canEditProfileImage = canUpdateProfileImage || Boolean(person.profileImage && canRemoveProfileImage);
  const canEditLoginEmail = Boolean(account) && hasPermission(
    currentUser,
    PermissionId.accountslogin_emailupdate,
  );
  const canCreateAccount = person.account === null && hasPermission(
    currentUser,
    PermissionId.accountscreate,
  );
  const canDeletePerson = hasPermission(currentUser, PermissionId.peopledelete) &&
    (hasPermission(currentUser, PermissionId.accountsdelete) ||
      (canReadAccounts && person.account === null));
  const canDisableAccount =
    account?.status === 'enabled' &&
    hasPermission(currentUser, PermissionId.accountsdisable);
  const canDeleteAccount = Boolean(account) && hasPermission(
    currentUser,
    PermissionId.accountsdelete,
  );
  const canAssignRole = Boolean(account) && canAssignRoles && canReadRoles;
  // Emergency administrator password setting remains an API-only compatibility
  // operation; routine UI workflows use recipient-owned invitations and resets.
  const canSetPassword = false;
  const passwordIdentity = account?.authIdentities.find((identity) => identity.kind === 'password');
  const pinIdentity = account?.authIdentities.find((identity) => identity.kind === 'pin');
  const oidcIdentities = account?.authIdentities.filter((identity) => identity.kind === 'oidc') ?? [];
  const hasUsableAuthenticationMethod = account?.authIdentities.some((identity) => identity.usable) ?? false;
  const canIssuePasswordReset = Boolean(passwordIdentity) && account?.passwordStatus === 'active' && hasPermission(
    currentUser,
    PermissionId.accountspasswordreset,
  );
  const canInvite = Boolean(passwordIdentity) && account?.passwordStatus !== 'active' && hasPermission(
    currentUser,
    PermissionId.accountspasswordenrollall,
  );
  const canConfigurePIN = Boolean(account) && (pinIdentity
    ? hasPermission(currentUser, PermissionId.accountspinreset)
    : hasPermission(currentUser, PermissionId.accountspinenrollall));
  const canRemovePasswordIdentity = Boolean(passwordIdentity) && hasPermission(
    currentUser,
    PermissionId.accountspasswordremoveall,
  );
  const canRemovePINIdentity = Boolean(pinIdentity) && hasPermission(
    currentUser,
    PermissionId.accountspinremoveall,
  );
  const canRemoveOIDCIdentity = hasPermission(currentUser, PermissionId.identitiesoidcunlinkall);
  const hasAccountActions = canEditLoginEmail || canCreateAccount || canAssignRole;
  const hasCredentialActions = canSetPassword || canIssuePasswordReset || canInvite || canConfigurePIN;
  const availableTabs = useMemo(() => personDetailTabs.filter((tab) => {
    if (tab.key === 'account-access') return canReadAccounts;
    if (tab.key === 'roles-permissions') return canReadAccounts && Boolean(account);
    if (tab.key === 'makerspace-status') return canReadMakerspaceStatus;
    return true;
  }), [account, canReadAccounts, canReadMakerspaceStatus]);
  const requestedTab = searchParams.get('tab');
  const selectedTabIndex = Math.max(
    0,
    availableTabs.findIndex((tab) => tab.key === requestedTab),
  );
  const selectedTab = availableTabs[selectedTabIndex]?.key ?? 'overview';

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
  const accountEmailForm = useForm<AccountEmailForm>({ defaultValues: { loginEmail: passwordIdentity?.displayIdentifier ?? '' } });
  const accountPasswordForm = useForm<AccountPasswordForm>({ defaultValues: { newPassword: '', confirmPassword: '' } });
  const accountPINForm = useForm<AccountPINForm>({ defaultValues: { loginName: pinIdentity?.displayIdentifier ?? '', pin: '', confirmPIN: '' } });

  useEffect(() => {
    accountEmailForm.reset({ loginEmail: passwordIdentity?.displayIdentifier ?? '' });
  }, [passwordIdentity?.displayIdentifier, accountEmailForm]);

  useEffect(() => {
    accountPINForm.reset({ loginName: pinIdentity?.displayIdentifier ?? '', pin: '', confirmPIN: '' });
  }, [pinIdentity?.displayIdentifier, accountPINForm]);

  useEffect(() => {
    if (!requestedTab) return;
    if (requestedTab !== 'overview' && availableTabs.some((tab) => tab.key === requestedTab)) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('tab');
      return next;
    }, { replace: true });
  }, [availableTabs, requestedTab, setSearchParams]);

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
    mutationFn: ({ loginEmail }: AccountEmailForm) => updateAccountLoginEmail(account!.id, { loginEmail: loginEmail.trim(), expectedVersion: account!.version }),
    onSuccess: async () => {
      setLoginEmailModalOpen(false);
      await refresh();
    },
  });
  const pinMutation = useSecretMutation(
    ({ loginName, pin }: AccountPINForm) => setAccountPin(account!.id, { loginName: loginName.trim(), pin, expectedVersion: account!.version }),
    {
      onSuccess: async () => {
        accountPINForm.reset({ loginName: '', pin: '', confirmPIN: '' });
        setPINModalOpen(false);
        await refresh();
      },
    },
  );
  const passwordMutation = useSecretMutation(
    ({ newPassword }: AccountPasswordForm) => setAccountPassword(account!.id, { newPassword, expectedVersion: account!.version }),
    {
    onSuccess: async () => {
      accountPasswordForm.reset();
      clearResetIssue();
      setPasswordModalOpen(false);
      await refresh();
    },
    },
  );
  const enableMutation = useMutation({ mutationFn: () => enableAccount(account!.id, { expectedVersion: account!.version }), onSuccess: refresh });
  const disableMutation = useMutation({ mutationFn: () => disableAccount(account!.id, { expectedVersion: account!.version }), onSuccess: async () => { setConfirmKind(null); await refresh(); } });
  const deleteAccountMutation = useMutation({ mutationFn: () => deleteAccount(account!.id, { expectedVersion: account!.version }), onSuccess: async () => { setConfirmKind(null); clearResetIssue(); queryClient.removeQueries({ queryKey: ['accounts', 'detail', account!.id] }); await refresh(); } });
  const removeAuthIdentityMutation = useMutation({
    mutationFn: (identity: AuthIdentitySummary) => removeAccountAuthIdentity(
      account!.id,
      identity.id,
      { expectedVersion: account!.version },
    ),
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
    mutationFn: ({ roleId, remove }: { roleId: string; remove: boolean }) => remove
      ? removeAccountRole(account!.id, roleId, { expectedVersion: account!.version })
      : assignAccountRole(account!.id, roleId, { expectedVersion: account!.version }),
    onSuccess: async () => {
      setSelectedRole(null);
      setAssignRoleOpen(false);
      await Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: authQueryKey }),
      ]);
    },
  });
  const profileImageMutation = useMutation({
    mutationFn: (file: File) => apiFetch<ProfileImage>(
      getPutPersonProfileImageUrl(person.id, { expectedVersion: person.version }),
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': file.name,
          'X-Profile-Image-Source': currentUser.person.id === person.id ? 'self_upload' : 'admin_upload',
        },
        body: file,
      },
    ),
    onSuccess: async () => {
      await refreshPersonData(queryClient, person.id);
      if (currentUser.person.id === person.id) {
        await queryClient.invalidateQueries({ queryKey: authQueryKey });
      }
    },
  });
  const removeProfileImageMutation = useMutation({
    mutationFn: () => deletePersonProfileImage(person.id, { expectedVersion: person.version }),
    onSuccess: async () => {
      await refreshPersonData(queryClient, person.id);
      if (currentUser.person.id === person.id) {
        await queryClient.invalidateQueries({ queryKey: authQueryKey });
      }
    },
  });

  const rolesQuery = useQuery({ ...fullRoleCatalogOptions, enabled: Boolean(account && canReadRoles) });
  const rolesById = useMemo(
    () => new Map((rolesQuery.data ?? []).map((role) => [role.id, role])),
    [rolesQuery.data],
  );
  const assignableRoles = useMemo(() => {
    const assigned = new Set(account?.roles.map((role) => role.id) ?? []);
    return (rolesQuery.data ?? []).filter(
      (role) =>
        !assigned.has(role.id) &&
        canManageRoleMembership(currentUser, role),
    );
  }, [account?.roles, currentUser, rolesQuery.data]);

  const submitPerson = personForm.handleSubmit(async (values) => {
    try {
      await personMutation.mutateAsync(toPersonPatch(values, personForm.formState.dirtyFields, person.version, canEditMatriculation));
    } catch { /* rendered below */ }
  });
  const submitCreateAccount = accountCreateForm.handleSubmit(async (values) => {
    try { await createAccountMutation.mutateAsync(values); } catch { /* rendered in modal */ }
  });
  const submitEmail = accountEmailForm.handleSubmit(async (values) => {
    try { await emailMutation.mutateAsync(values); } catch { /* rendered below */ }
  });
  const submitPassword = accountPasswordForm.handleSubmit(async (values) => {
    try { await passwordMutation.mutateAsync(values); } catch { /* rendered in modal */ }
  });
  const submitPIN = accountPINForm.handleSubmit(async (values) => {
    try { await pinMutation.mutateAsync(values); } catch { /* rendered in modal */ }
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
      if (confirmKind === 'reset-password' || confirmKind === 'invite' || confirmKind === 'pin-setup') setResetFailed(true);
    } finally {
      setResetPending(false);
    }
  };

  const confirmation = {
    'delete-person': ['Delete person permanently?', 'This permanently deletes the person and, if present, their account. This cannot be undone.', 'Delete person'],
    'delete-account': ['Delete account permanently?', 'The person record remains, but the login account is permanently removed.', 'Delete account'],
    'disable-account': ['Disable this account?', 'The user will be signed out and will not be able to sign in.', 'Disable account'],
    'reset-password': ['Send a password reset code?', 'A one-time code will be emailed. The current password remains active until the recipient completes the reset.', 'Send reset code'],
    invite: ['Send an account invitation?', 'A one-time setup code will be emailed. Completing it verifies the email, sets the password, and enables an account that was not explicitly disabled.', 'Send invitation'],
    'pin-setup': [pinIdentity ? 'Create a PIN reset link?' : 'Create a PIN setup link?', 'A one-time setup link will be emailed when a contact address and mail delivery are available. Otherwise, copy the returned link and deliver it through a trusted channel.', pinIdentity ? 'Create PIN reset link' : 'Create PIN setup link'],
  } as const;
  const selectedConfirmation = confirmKind === 'remove-auth-method'
    ? authIdentityToRemove
      ? [
          `Remove ${authenticationMethodName(authIdentityToRemove.kind)}?`,
          'This removes the login method and signs out existing account sessions. The account remains active or inactive independently.',
          'Remove method',
        ] as const
      : null
    : confirmKind ? confirmation[confirmKind] : null;
  const mutationError = personMutation.isError || createAccountMutation.isError || emailMutation.isError || passwordMutation.isError || pinMutation.isError || enableMutation.isError || disableMutation.isError || deleteAccountMutation.isError || removeAuthIdentityMutation.isError || deletePersonMutation.isError || roleMutation.isError || resetFailed;
  const hasPersonActions = canEditPerson || canEditLoginEmail || canCreateAccount ||
    canAssignRole || canSetPassword || canIssuePasswordReset || canInvite ||
    canConfigurePIN;

  const selectTab = (tab: PersonDetailTab) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (tab === 'overview') next.delete('tab');
      else next.set('tab', tab);
      return next;
    });
  };

  const startEditingPerson = () => {
    setEditingPerson(true);
    selectTab('personal-information');
  };

  const startEditingAccount = () => {
    setLoginEmailModalOpen(true);
    selectTab('account-access');
  };

  const openRoleManager = () => {
    setAssignRoleOpen(true);
    selectTab('roles-permissions');
  };

  const renderProfileSection = () => (
    <DetailSection
      title="Profile picture"
      className="person-profile-card"
      headingContent={(
        <div className="person-profile-card__identity">
          <PersonAvatar
            firstName={person.firstName}
            lastName={person.lastName}
            profileImage={person.profileImage}
            size="lg"
          />
        </div>
      )}
      action={canEditProfileImage ? (
        <ProfilePictureEditor
          id="person-profile-image"
          firstName={person.firstName}
          lastName={person.lastName}
          profileImage={person.profileImage}
          canUpdate={canUpdateProfileImage}
          canRemove={canRemoveProfileImage}
          isUploading={profileImageMutation.isPending}
          isRemoving={removeProfileImageMutation.isPending}
          trigger="button"
          onUpload={(file) => profileImageMutation.mutate(file)}
          onRemove={() => removeProfileImageMutation.mutate()}
        />
      ) : undefined}
    >
      {person.profileImageRequired && !person.profileImage && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title="Profile picture required" subtitle="At least one assigned role requires a profile picture." />
      )}
      {profileImageMutation.isError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Picture not updated" subtitle="Use a JPEG, PNG, or WebP image up to 8 MiB and 4096×4096 pixels." />
      )}
    </DetailSection>
  );

  const renderPersonalInformationSection = () => (
    <DetailSection
      title="Personal information"
      action={canEditPerson && !editingPerson ? (
        <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setEditingPerson(true)}>
          Edit
        </Button>
      ) : undefined}
    >
      {editingPerson ? (
        <Form onSubmit={submitPerson}>
          <Stack gap={6}>
            <PersonFields form={personForm} showMatriculation={canReadMatriculation} editMatriculation={canEditMatriculation} />
            <div className="form-actions">
              <Button kind="secondary" type="button" onClick={() => { personForm.reset(); setEditingPerson(false); }}>Cancel</Button>
              <Button type="submit" disabled={!personForm.formState.isDirty || personMutation.isPending}>{personMutation.isPending ? 'Saving…' : 'Save'}</Button>
            </div>
          </Stack>
        </Form>
      ) : (
        <StructuredListWrapper isCondensed>
          <StructuredListBody>
            <DetailRow label="First name" value={person.firstName} />
            <DetailRow label="Last name" value={person.lastName} />
            <DetailRow label="Contact email" value={person.email ?? 'Not provided'} />
            <DetailRow label="Phone" value={person.phone ?? 'Not provided'} />
            {canReadMatriculation && <DetailRow label="Matriculation number" value={person.matriculationNumber ?? 'Not provided'} />}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
    </DetailSection>
  );

  const renderAccountAccessSection = () => (
    <DetailSection
      title="Account access"
      meta={account && <Tag type={account.status === 'enabled' ? 'green' : 'gray'}>{account.status === 'enabled' ? 'Active' : 'Inactive'}</Tag>}
    >
      {!canReadAccounts || person.account === undefined ? (
        <InlineNotification kind="info" lowContrast hideCloseButton title="Account details unavailable" subtitle="Your permissions do not include account access." />
      ) : !account ? (
        <Stack gap={5}>
          <p>This person does not have an application account.</p>
          {canCreateAccount && <Button size="sm" onClick={() => setCreateAccountOpen(true)}>Create account</Button>}
        </Stack>
      ) : (
        <Stack gap={5}>
          <StructuredListWrapper isCondensed>
            <StructuredListBody>
              <DetailRow label="Account status" value={account.status === 'enabled' ? 'Active' : 'Inactive'} />
              <DetailRow label="Provisioning source" value={formatProvisioningSource(account.provisioningSource)} />
              <DetailRow label="First sign-in" value={account.firstAuthenticatedAt ? new Date(account.firstAuthenticatedAt).toLocaleString() : 'Not yet'} />
              <DetailRow
                label="Account ID"
                value={account.id}
                monospace
                action={(
                  <CopyButton
                    size="sm"
                    iconDescription="Copy account ID"
                    feedback="Account ID copied"
                    onClick={() => void navigator.clipboard.writeText(account.id)}
                  />
                )}
              />
            </StructuredListBody>
          </StructuredListWrapper>
          {account.status === 'disabled' && hasPermission(currentUser, PermissionId.accountsenable) && (
            <div>
              <Button size="sm" disabled={enableMutation.isPending} onClick={() => enableMutation.mutate()}>Activate account</Button>
            </div>
          )}
        </Stack>
      )}
    </DetailSection>
  );

  const renderAuthenticationMethodsSection = () => account ? (
    <DetailSection
      title="Authentication methods"
      meta={!hasUsableAuthenticationMethod ? <Tag type="gray">No login methods</Tag> : undefined}
    >
      <div className="authentication-methods">
        <AuthenticationMethod
          label="Local password"
          status={!passwordIdentity ? 'Not configured' : passwordIdentity.disabledAt ? 'Disabled' : passwordIdentity.usable ? 'Active' : account.passwordStatus === 'reset_required' ? 'Reset required' : 'Not configured'}
          detail={passwordIdentity?.displayIdentifier ?? undefined}
          active={passwordIdentity?.usable ?? false}
          warning={account.passwordStatus === 'reset_required'}
          action={(canEditLoginEmail || canIssuePasswordReset || canInvite || canRemovePasswordIdentity) ? (
            <OverflowMenu iconDescription="Actions for Local password" size="sm" flipped>
              {canEditLoginEmail && <OverflowMenuItem itemText={passwordIdentity ? 'Change login email' : 'Add password login'} onClick={() => setLoginEmailModalOpen(true)} />}
              {canIssuePasswordReset && <OverflowMenuItem itemText="Send reset code" onClick={() => setConfirmKind('reset-password')} />}
              {canInvite && <OverflowMenuItem itemText="Send invitation" onClick={() => setConfirmKind('invite')} />}
              {canRemovePasswordIdentity && <OverflowMenuItem isDelete hasDivider={canEditLoginEmail || canIssuePasswordReset || canInvite} itemText="Remove password method" onClick={() => { setAuthIdentityToRemove(passwordIdentity ?? null); setConfirmKind('remove-auth-method'); }} />}
            </OverflowMenu>
          ) : undefined}
        />
        <AuthenticationMethod
          label="Username and PIN"
          status={!pinIdentity ? 'Not configured' : pinIdentity.disabledAt ? 'Disabled' : pinIdentity.usable ? 'Active' : 'Not configured'}
          detail={pinIdentity?.displayIdentifier ? `Username: ${pinIdentity.displayIdentifier}` : undefined}
          active={pinIdentity?.usable ?? false}
          action={(canConfigurePIN || canRemovePINIdentity) ? (
            <OverflowMenu iconDescription="Actions for Username and PIN" size="sm" flipped>
              {canConfigurePIN && <OverflowMenuItem itemText={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'} onClick={() => setPINModalOpen(true)} />}
              {canConfigurePIN && <OverflowMenuItem itemText={pinIdentity ? 'Create setup link' : 'Create setup link instead'} onClick={() => setConfirmKind('pin-setup')} />}
              {canRemovePINIdentity && <OverflowMenuItem isDelete hasDivider={canConfigurePIN} itemText="Remove PIN method" onClick={() => { setAuthIdentityToRemove(pinIdentity ?? null); setConfirmKind('remove-auth-method'); }} />}
            </OverflowMenu>
          ) : undefined}
        />
        <AuthenticationMethod
          label="OIDC / SSO"
          status={oidcIdentities.length ? `${oidcIdentities.filter((identity) => identity.usable).length} active` : 'Not connected'}
          active={oidcIdentities.some((identity) => identity.usable)}
        >
          {oidcIdentities.map((identity) => (
            <div className="authentication-method__identity" key={identity.id}>
              <div className="authentication-method__identity-summary">
                <span>{identity.displayIdentifier ?? 'OIDC provider'}</span>
                <span>{identity.disabledAt ? 'Disabled' : identity.usable ? 'Active' : 'Provider unavailable'}</span>
                {identity.providerSlug && <code>{identity.providerSlug}</code>}
              </div>
              {canRemoveOIDCIdentity && (
                <OverflowMenu iconDescription={`Actions for ${identity.displayIdentifier ?? 'OIDC identity'}`} size="sm" flipped>
                  <OverflowMenuItem isDelete itemText="Unlink identity" onClick={() => { setAuthIdentityToRemove(identity); setConfirmKind('remove-auth-method'); }} />
                </OverflowMenu>
              )}
            </div>
          ))}
        </AuthenticationMethod>
      </div>
    </DetailSection>
  ) : null;

  const renderRolesSection = () => account ? (
    <DetailSection
      title="Roles"
      meta={<span className="section-description">{account.roles.length} assigned</span>}
      action={canAssignRole ? <Button kind="ghost" size="sm" onClick={() => setAssignRoleOpen(true)}>Manage roles</Button> : undefined}
    >
      <div className="tag-list" aria-label="Assigned roles">
        {account.roles.length === 0 && <span>No roles assigned</span>}
        {account.roles.map((role) => {
          const roleDetails = rolesById.get(role.id);
          const mayRemove = Boolean(roleDetails && canManageRoleMembership(currentUser, roleDetails));
          if (mayRemove) {
            return <DismissibleTag key={role.id} type={role.systemKey === 'master' ? 'purple' : 'blue'} text={role.name} title={`Remove ${role.name} role`} dismissTooltipLabel={`Remove ${role.name} role`} onClose={() => roleMutation.mutate({ roleId: role.id, remove: true })} />;
          }
          return <Tag key={role.id} type={role.systemKey === 'master' ? 'purple' : 'blue'}>{role.name}</Tag>;
        })}
      </div>
    </DetailSection>
  ) : null;

  const renderMakerspaceStatusSection = () => canReadMakerspaceStatus ? (
    <DetailSection
      title="Makerspace status"
      className="person-makerspace-card"
      description="Upcoming participation and current Lab Rules acknowledgement."
    >
      {makerspaceStatusQuery.isPending && <InlineLoadingState label="Loading Makerspace status" />}
      {makerspaceStatusQuery.isError && <InlineNotification kind="warning" lowContrast hideCloseButton title="Makerspace status unavailable" subtitle="Personal and account details are still available. Reload to try again." />}
      {makerspaceStatusQuery.data?.laborordnungStatus && (
        <LabRulesOverview status={makerspaceStatusQuery.data.laborordnungStatus} />
      )}
      {makerspaceStatusQuery.data?.upcomingOpenDayAssignments && (
        <div className="person-open-days">
          <div className="section-heading"><h3>Upcoming Open Days</h3><Tag type="cool-gray">{makerspaceStatusQuery.data.upcomingOpenDayAssignments.length}</Tag></div>
          {makerspaceStatusQuery.data.upcomingOpenDayAssignments.length === 0 ? (
            <p className="section-description">No upcoming Open Day assignments.</p>
          ) : (
            <StructuredListWrapper isCondensed aria-label="Upcoming Open Day assignments">
              <StructuredListBody>
                {makerspaceStatusQuery.data.upcomingOpenDayAssignments.map((assignment) => (
                  <StructuredListRow key={assignment.assignmentId}>
                    <StructuredListCell>
                      <strong>{assignment.periodName}</strong>
                      <span className="person-open-days__time">{formatDateTimeRange(assignment.startsAt, assignment.endsAt)}</span>
                    </StructuredListCell>
                    <StructuredListCell><Tag type={assignment.role === 'supervisor' ? 'blue' : 'teal'}>{capitalize(assignment.role)}</Tag></StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
          )}
        </div>
      )}
    </DetailSection>
  ) : null;

  const renderTabContent = (tab: PersonDetailTab) => {
    if (tab === 'personal-information') {
      return (
        <Grid className="person-detail-grid person-detail-grid--personal">
          <Column sm={4} md={3} lg={6} className="person-detail-grid__stretch-cell">
            {renderProfileSection()}
          </Column>
          <Column sm={4} md={5} lg={10} className="person-detail-grid__stretch-cell">
            {renderPersonalInformationSection()}
          </Column>
        </Grid>
      );
    }
    if (tab === 'account-access') {
      return <Stack gap={6}>{renderAccountAccessSection()}{renderAuthenticationMethodsSection()}</Stack>;
    }
    if (tab === 'roles-permissions') return renderRolesSection();
    if (tab === 'makerspace-status') return renderMakerspaceStatusSection();

    return (
      <Grid className="person-detail-grid person-detail-grid--overview">
        <Column sm={4} md={3} lg={6} className="person-detail-grid__stretch-cell">
          {renderProfileSection()}
        </Column>
        <Column sm={4} md={5} lg={10} className="person-detail-grid__stretch-cell">
          {renderAccountAccessSection()}
        </Column>
        <Column sm={4} md={3} lg={6} className="person-detail-grid__stretch-cell">
          {renderPersonalInformationSection()}
        </Column>
        <Column sm={4} md={5} lg={10} className="person-detail-overview__stack">
          <Stack gap={6}>{renderAuthenticationMethodsSection()}{renderRolesSection()}</Stack>
        </Column>
        {canReadMakerspaceStatus && (
          <Column sm={4} md={8} lg={16}>{renderMakerspaceStatusSection()}</Column>
        )}
      </Grid>
    );
  };

  return (
    <Stack gap={7} className="person-detail-page">
      <PageHeader
        title={`${person.firstName} ${person.lastName}`}
        breadcrumbs={[
          { label: 'People', to: '/people' },
          { label: `${person.firstName} ${person.lastName}` },
        ]}
        description="Personal details, account access, and Makerspace status."
        actions={hasPersonActions ? (
          <MenuButton label="Actions" kind="primary" menuAlignment="bottom-end" size="md">
            {canEditPerson && !editingPerson && (
              <MenuItem label="Edit person" onClick={startEditingPerson} />
            )}
            {canEditPerson && !editingPerson && (hasAccountActions || hasCredentialActions) && (
              <MenuItemDivider />
            )}
            {canEditLoginEmail && (
              <MenuItem label={passwordIdentity ? 'Change password login email' : 'Add password login'} onClick={startEditingAccount} />
            )}
            {canCreateAccount && (
              <MenuItem label="Create account" onClick={() => { setCreateAccountOpen(true); selectTab('account-access'); }} />
            )}
            {canAssignRole && (
              <MenuItem label="Manage roles" onClick={openRoleManager} />
            )}
            {hasAccountActions && hasCredentialActions && <MenuItemDivider />}
            {canSetPassword && (
              <MenuItem label="Set password" onClick={() => setPasswordModalOpen(true)} />
            )}
            {canIssuePasswordReset && (
              <MenuItem label="Send reset code" onClick={() => setConfirmKind('reset-password')} />
            )}
            {canInvite && (
              <MenuItem label="Send invitation" onClick={() => setConfirmKind('invite')} />
            )}
            {canConfigurePIN && (
              <MenuItem label={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'} onClick={() => setPINModalOpen(true)} />
            )}
          </MenuButton>
        ) : undefined}
      />
      {mutationError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Change not completed" subtitle="The record may have changed. Reload it and try again." />
      )}
      <div className="person-detail-layout">
        <Tabs
          selectedIndex={selectedTabIndex}
          onChange={({ selectedIndex }) => {
            const nextTab = availableTabs[selectedIndex];
            if (nextTab) selectTab(nextTab.key);
          }}
        >
          <TabList aria-label="Person detail sections">
            {availableTabs.map((tab) => <Tab key={tab.key}>{tab.label}</Tab>)}
          </TabList>
          <TabPanels>
            {availableTabs.map((tab) => (
              <TabPanel key={tab.key} className="person-detail-tab-panel">
                {tab.key === selectedTab ? renderTabContent(tab.key) : null}
              </TabPanel>
            ))}
          </TabPanels>
        </Tabs>

      {resetSent && !manualSetupUrl && (
        <Tile className="secret-tile">
          <Stack gap={5}>
            <InlineNotification kind="success" lowContrast hideCloseButton title="Message sent" subtitle="The one-time link was sent by email." />
            {resetExpiresAt && <p className="section-description">Expires {new Date(resetExpiresAt).toLocaleString()}.</p>}
            <div className="form-actions">
              <Button kind="ghost" onClick={clearResetIssue}>Dismiss</Button>
            </div>
          </Stack>
        </Tile>
      )}

      {(canDisableAccount || canDeleteAccount || canDeletePerson) && (
        <Tile className="danger-zone">
          <Stack gap={5}>
            <div>
              <h2>Danger zone</h2>
              <p className="danger-zone__description">
                These actions affect account access or permanently remove data.
              </p>
            </div>
            <div className="button-cluster">
              {canDisableAccount && (
                <Button kind="danger--tertiary" size="md" onClick={() => setConfirmKind('disable-account')}>
                  Disable account
                </Button>
              )}
              {canDeleteAccount && (
                <Button kind="danger--tertiary" size="md" onClick={() => setConfirmKind('delete-account')}>
                  Delete account
                </Button>
              )}
              {canDeletePerson && (
                <Button kind="danger--tertiary" size="md" renderIcon={TrashCan} onClick={() => setConfirmKind('delete-person')}>
                  Delete person
                </Button>
              )}
            </div>
          </Stack>
        </Tile>
      )}
      </div>

      <ComposedModal open={createAccountOpen} onClose={() => setCreateAccountOpen(false)}>
        <ModalHeader title="Create account" label={`${person.firstName} ${person.lastName}`} />
        <ModalBody>
          <Form id="create-account-form" onSubmit={submitCreateAccount}>
            <Stack gap={5}>
              <p>Create an active application account for this person. Authentication methods can be configured afterwards; without one, the person cannot sign in.</p>
              {createAccountMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Account not created" subtitle="Check the email and try again." />}
              <TextInput
                id="new-account-email"
                type="email"
                labelText="Password login email (optional)"
                helperText="This creates a password identity for convenience. It is independent of the person's contact email."
                invalid={Boolean(accountCreateForm.formState.errors.loginEmail)}
                invalidText={accountCreateForm.formState.errors.loginEmail?.message}
                {...accountCreateForm.register('loginEmail')}
              />
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter><Button kind="secondary" onClick={() => setCreateAccountOpen(false)}>Cancel</Button><Button type="submit" form="create-account-form" disabled={createAccountMutation.isPending}>Create account</Button></ModalFooter>
      </ComposedModal>

      <ComposedModal open={loginEmailModalOpen} onClose={() => { accountEmailForm.reset({ loginEmail: passwordIdentity?.displayIdentifier ?? '' }); emailMutation.reset(); setLoginEmailModalOpen(false); }}>
        <ModalHeader title={passwordIdentity ? 'Change password login email' : 'Add password login'} label={`${person.firstName} ${person.lastName}`} />
        <ModalBody>
          <Form id="account-login-email-form" onSubmit={submitEmail}>
            <Stack gap={5}>
              <p>This identifier is used only for local password authentication. It does not change the person's contact email.</p>
              {emailMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Password login not updated" subtitle="The email may already be in use or the account may have changed." />}
              <TextInput id="account-login-email" type="email" labelText="Password login email" invalid={Boolean(accountEmailForm.formState.errors.loginEmail)} invalidText={accountEmailForm.formState.errors.loginEmail?.message} {...accountEmailForm.register('loginEmail', { required: 'Enter a password login email.' })} />
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={() => { accountEmailForm.reset({ loginEmail: passwordIdentity?.displayIdentifier ?? '' }); emailMutation.reset(); setLoginEmailModalOpen(false); }}>Cancel</Button>
          <Button type="submit" form="account-login-email-form" disabled={emailMutation.isPending}>{emailMutation.isPending ? 'Saving…' : 'Save'}</Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal open={pinModalOpen} onClose={() => { accountPINForm.reset({ loginName: pinIdentity?.displayIdentifier ?? '', pin: '', confirmPIN: '' }); pinMutation.reset(); setPINModalOpen(false); }}>
        <ModalHeader title={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'} label={`${person.firstName} ${person.lastName}`} />
        <ModalBody>
          <Form id="set-account-pin-form" onSubmit={submitPIN}>
            <Stack gap={5}>
              <p>Configure this method directly. Existing account sessions will be signed out.</p>
              {pinMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="PIN login not configured" subtitle="The username may be unavailable or the account may have changed." />}
              <TextInput id="admin-pin-login-name" labelText="Username" autoComplete="username" helperText="3–64 letters, numbers, dots, underscores, or hyphens; start with a letter or number." invalid={Boolean(accountPINForm.formState.errors.loginName)} invalidText={accountPINForm.formState.errors.loginName?.message} {...accountPINForm.register('loginName', { required: 'Enter a username.', pattern: { value: /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/, message: 'Use 3 to 64 supported characters and start with a letter or number.' } })} />
              <PasswordInput id="admin-pin" labelText="PIN" autoComplete="new-password" helperText="Use 6 to 12 digits." invalid={Boolean(accountPINForm.formState.errors.pin)} invalidText={accountPINForm.formState.errors.pin?.message} {...accountPINForm.register('pin', { required: 'Enter a PIN.', pattern: { value: /^[0-9]{6,12}$/, message: 'Use 6 to 12 digits.' } })} />
              <PasswordInput id="admin-confirm-pin" labelText="Confirm PIN" autoComplete="new-password" invalid={Boolean(accountPINForm.formState.errors.confirmPIN)} invalidText={accountPINForm.formState.errors.confirmPIN?.message} {...accountPINForm.register('confirmPIN', { required: 'Confirm the PIN.', validate: (value) => value === accountPINForm.watch('pin') || 'The PINs do not match.' })} />
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={() => { accountPINForm.reset({ loginName: pinIdentity?.displayIdentifier ?? '', pin: '', confirmPIN: '' }); pinMutation.reset(); setPINModalOpen(false); }}>Cancel</Button>
          <Button type="submit" form="set-account-pin-form" disabled={pinMutation.isPending}>{pinMutation.isPending ? 'Saving…' : 'Set PIN login'}</Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal open={assignRoleOpen} onClose={() => { setSelectedRole(null); setAssignRoleOpen(false); }}>
        <ModalHeader title="Assign role" label={`${person.firstName} ${person.lastName}`} />
        <ModalBody>
          <Stack gap={5}>
            {rolesQuery.isPending && <InlineLoadingState label="Loading role catalog" />}
            {rolesQuery.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Role catalog unavailable"
                subtitle="Reload the person and try again."
              />
            )}
            {rolesQuery.data && assignableRoles.length === 0 && (
              <p>No additional roles are available.</p>
            )}
            {rolesQuery.data && assignableRoles.length > 0 && (
              <Dropdown id="assign-role" titleText="Role" label="Choose a role" items={assignableRoles} itemToString={(item) => item?.name ?? ''} selectedItem={selectedRole} onChange={({ selectedItem }) => setSelectedRole(selectedItem ?? null)} />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={() => { setSelectedRole(null); setAssignRoleOpen(false); }}>
            Cancel
          </Button>
          <Button disabled={!selectedRole || roleMutation.isPending} onClick={() => selectedRole && roleMutation.mutate({ roleId: selectedRole.id, remove: false })}>
            {roleMutation.isPending ? 'Assigning…' : 'Assign role'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal open={passwordModalOpen} onClose={() => { accountPasswordForm.reset(); passwordMutation.reset(); setPasswordModalOpen(false); }}>
        <ModalHeader title="Set account password" label={passwordIdentity?.displayIdentifier ?? undefined} />
        <ModalBody>
          <Form id="set-account-password-form" onSubmit={submitPassword}>
            <Stack gap={5}>
              {passwordMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Password not set" subtitle="Review the password and try again." />}
              <PasswordInput id="admin-new-password" labelText="New password" autoComplete="new-password" invalid={Boolean(accountPasswordForm.formState.errors.newPassword)} invalidText={accountPasswordForm.formState.errors.newPassword?.message} {...accountPasswordForm.register('newPassword', { required: 'Enter a password.', validate: validatePasswordLength })} />
              <PasswordInput id="admin-confirm-password" labelText="Confirm password" autoComplete="new-password" invalid={Boolean(accountPasswordForm.formState.errors.confirmPassword)} invalidText={accountPasswordForm.formState.errors.confirmPassword?.message} {...accountPasswordForm.register('confirmPassword', { required: 'Confirm the password.', validate: (value) => value === accountPasswordForm.watch('newPassword') || 'The passwords do not match.' })} />
              <p className="section-description">Setting a password revokes existing sessions and reset links.</p>
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter><Button kind="secondary" onClick={() => { accountPasswordForm.reset(); passwordMutation.reset(); setPasswordModalOpen(false); }}>Cancel</Button><Button type="submit" form="set-account-password-form" disabled={passwordMutation.isPending}>Set password</Button></ModalFooter>
      </ComposedModal>

      <ComposedModal aria-label="Manual setup link created" open={Boolean(manualSetupUrl)} onClose={clearResetIssue}>
        <ModalHeader title="Manual setup link created" label={`${person.firstName} ${person.lastName}`} />
        <ModalBody>
          <Stack gap={5}>
            <p>Copy this one-time link and deliver it to the intended recipient through a trusted channel.</p>
            {manualSetupUrl && (
              <TextInput
                id="manual-setup-url"
                labelText="One-time setup link"
                readOnly
                value={`${window.location.origin}${manualSetupUrl}`}
              />
            )}
            {resetExpiresAt && <p className="section-description">Expires {new Date(resetExpiresAt).toLocaleString()}.</p>}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={clearResetIssue}>Done</Button>
          <Button onClick={() => manualSetupUrl && void navigator.clipboard.writeText(`${window.location.origin}${manualSetupUrl}`)}>Copy link</Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal open={Boolean(selectedConfirmation)} danger onClose={() => { setConfirmKind(null); setAuthIdentityToRemove(null); removeAuthIdentityMutation.reset(); }}>
        <ModalHeader title={selectedConfirmation?.[0] ?? ''} />
        <ModalBody><p>{selectedConfirmation?.[1]}</p>{resetFailed && (confirmKind === 'reset-password' || confirmKind === 'invite' || confirmKind === 'pin-setup') && <InlineNotification kind="error" lowContrast hideCloseButton title="Message not sent" subtitle="Reload the account and try again." />}{confirmKind === 'remove-auth-method' && removeAuthIdentityMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Authentication method not removed" subtitle="The account may have changed. Reload it and try again." />}</ModalBody>
        <ModalFooter><Button kind="secondary" onClick={() => { setConfirmKind(null); setAuthIdentityToRemove(null); removeAuthIdentityMutation.reset(); }}>Cancel</Button><Button kind="danger" disabled={resetPending || deletePersonMutation.isPending || deleteAccountMutation.isPending || disableMutation.isPending || removeAuthIdentityMutation.isPending} onClick={() => void confirmAction()}>{selectedConfirmation?.[2] ?? 'Confirm'}</Button></ModalFooter>
      </ComposedModal>
    </Stack>
  );
}

function authenticationMethodName(kind: AuthIdentitySummary['kind']) {
  if (kind === 'password') return 'local password';
  if (kind === 'pin') return 'username and PIN';
  return 'OIDC identity';
}

function formatProvisioningSource(source: string): string {
  return source.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}

function LabRulesOverview({ status }: { status: LaborordnungStatus }) {
  const stateLabel = status.state === 'current'
    ? 'Current'
    : status.state === 'outdated'
      ? 'Acknowledgement outdated'
      : status.state === 'no_published_version'
        ? 'No published version'
        : 'Not required';
  const tagType = status.state === 'current' ? 'green' : status.actionRequired ? 'warm-gray' : 'gray';

  return (
    <section className="lab-rules-overview" aria-labelledby="person-lab-rules-heading">
      <div className="section-heading">
        <div>
          <h3 id="person-lab-rules-heading">Lab Rules</h3>
          <p className="section-description">Requirement mode: {status.mode.replace('_', ' ')}</p>
        </div>
        <div className="tag-list">
          <Tag type={tagType}>{stateLabel}</Tag>
          {status.requestId && <Tag type="purple">Confirmation pending</Tag>}
        </div>
      </div>
      <div className="lab-rules-overview__versions">
        <div><span className="label">Current version</span><strong>{status.currentVersion?.humanRevision ?? 'None published'}</strong></div>
        <div><span className="label">Acknowledged version</span><strong>{status.latestConfirmedVersion?.humanRevision ?? 'None'}</strong></div>
      </div>
    </section>
  );
}

function formatDateTimeRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(start);
  const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
  return `${date}, ${time.format(start)}–${time.format(end)}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
