import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Button,
  Column,
  ComposedModal,
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
  PasswordInput,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
  TextInput,
  Tile,
} from '@carbon/react';
import { TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router-dom';
import {
  assignAccountRole,
  createPersonAccount,
  deleteAccount,
  disableAccount,
  enableAccount,
  issueAccountInvitation,
  issueAccountPinEnrollment,
  issueAccountPasswordReset,
  removeAccountRole,
  setAccountPassword,
  updateAccountLoginEmail,
} from '../../api/generated/accounts/accounts';
import type {
  AccountSummary,
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
import { ProfilePictureEditor } from './ProfilePictureEditor';

type ConfirmKind = 'delete-person' | 'delete-account' | 'disable-account' | 'reset-password' | 'invite' | 'pin-setup' | null;
type AccountEmailForm = { loginEmail: string };
type AccountPasswordForm = { newPassword: string; confirmPassword: string };

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
  const queryClient = useQueryClient();
  const accountSummary = asAccount(person.account);
  const account: AccountSummary | undefined = accountSummary;
  const [editingPerson, setEditingPerson] = useState(false);
  const [editingEmail, setEditingEmail] = useState(false);
  const [assignRoleOpen, setAssignRoleOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null);
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
  const canViewSupervisorStaffing = hasPermission(
    currentUser,
    PermissionId.supervisor_dashboardread,
  );
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
  const canEditAccount = Boolean(account) && hasPermission(
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
  const canIssuePasswordReset = Boolean(account) && account?.passwordStatus === 'active' && hasPermission(
    currentUser,
    PermissionId.accountspasswordreset,
  );
  const canInvite = Boolean(account) && account?.passwordStatus !== 'active' && hasPermission(
    currentUser,
    PermissionId.accountspasswordenrollall,
  );
	const activePINIdentity = account?.authIdentities.find((identity) => identity.kind === 'pin' && !identity.disabledAt);
	const activeOIDCIdentities = account?.authIdentities.filter((identity) => identity.kind === 'oidc' && !identity.disabledAt) ?? [];
	const canIssuePINSetup = Boolean(account) && (activePINIdentity
		? hasPermission(currentUser, PermissionId.accountspinreset)
		: hasPermission(currentUser, PermissionId.accountspinenrollall));
  const hasAccountActions = canEditAccount || canCreateAccount || canAssignRole;
  const hasCredentialActions = canSetPassword || canIssuePasswordReset || canInvite || canIssuePINSetup;

  const personForm = useForm<PersonFormValues>({
    defaultValues: {
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email ?? '',
      phone: person.phone ?? '',
      matriculationNumber: person.matriculationNumber ?? '',
    },
  });
  const accountCreateForm = useForm<AccountEmailForm>({ defaultValues: { loginEmail: person.email ?? '' } });
  const accountEmailForm = useForm<AccountEmailForm>({ defaultValues: { loginEmail: account?.loginEmail ?? '' } });
  const accountPasswordForm = useForm<AccountPasswordForm>({ defaultValues: { newPassword: '', confirmPassword: '' } });

  useEffect(() => {
    accountEmailForm.reset({ loginEmail: account?.loginEmail ?? '' });
  }, [account?.loginEmail, accountEmailForm]);

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
    mutationFn: ({ loginEmail }: AccountEmailForm) => createPersonAccount(person.id, { loginEmail: loginEmail.trim(), expectedVersion: person.version }),
    onSuccess: async () => {
      setCreateAccountOpen(false);
      accountCreateForm.reset({ loginEmail: '' });
      await refresh();
    },
  });
  const emailMutation = useMutation({
    mutationFn: ({ loginEmail }: AccountEmailForm) => updateAccountLoginEmail(account!.id, { loginEmail: loginEmail.trim(), expectedVersion: account!.version }),
    onSuccess: async () => {
      setEditingEmail(false);
      await refresh();
    },
  });
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
  const deletePersonMutation = useMutation({
    mutationFn: () => deletePerson(person.id, { expectedVersion: person.version }),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: peopleKeys.detail(person.id) });
      await queryClient.invalidateQueries({ queryKey: peopleKeys.lists() });
      navigate('/settings/users', { replace: true });
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
  const supervisorRoleNames = useMemo(
    () => (account?.roles ?? [])
      .filter((role) => rolesById.get(role.id)?.supervisorDashboard)
      .map((role) => role.name),
    [account?.roles, rolesById],
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

  const confirmAction = async () => {
    try {
      if (confirmKind === 'delete-person') await deletePersonMutation.mutateAsync();
      if (confirmKind === 'delete-account') await deleteAccountMutation.mutateAsync();
      if (confirmKind === 'disable-account') await disableMutation.mutateAsync();
      if (confirmKind === 'reset-password' && account) {
        setResetPending(true);
        setResetFailed(false);
        const issue = await issueAccountPasswordReset(account.id, { expectedVersion: account.version });
        setResetSent(true);
        setResetExpiresAt(issue.expiresAt);
        setManualSetupUrl(issue.setupUrl ?? null);
        queryClient.setQueryData(['accounts', 'detail', issue.account.id], issue.account);
        await refresh();
        setConfirmKind(null);
      }
      if (confirmKind === 'invite' && account) {
        setResetPending(true);
        setResetFailed(false);
        const issue = await issueAccountInvitation(account.id, { expectedVersion: account.version });
        setResetSent(true);
        setResetExpiresAt(issue.expiresAt);
        setManualSetupUrl(issue.setupUrl ?? null);
        queryClient.setQueryData(['accounts', 'detail', issue.account.id], issue.account);
        await refresh();
        setConfirmKind(null);
      }
	  if (confirmKind === 'pin-setup' && account) {
		setResetPending(true);
		setResetFailed(false);
		const issue = await issueAccountPinEnrollment(account.id, { expectedVersion: account.version });
		setResetSent(true);
		setResetExpiresAt(issue.expiresAt);
		setManualSetupUrl(issue.setupUrl ?? null);
		queryClient.setQueryData(['accounts', 'detail', issue.account.id], issue.account);
		await refresh();
		setConfirmKind(null);
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
	'pin-setup': [activePINIdentity ? 'Send a PIN reset code?' : 'Add PIN login?', 'A one-time setup code will be emailed. The recipient—not the administrator—chooses the permanent username and PIN.', activePINIdentity ? 'Send PIN reset code' : 'Send PIN setup code'],
  } as const;
  const selectedConfirmation = confirmKind ? confirmation[confirmKind] : null;
  const mutationError = personMutation.isError || createAccountMutation.isError || emailMutation.isError || passwordMutation.isError || enableMutation.isError || disableMutation.isError || deleteAccountMutation.isError || deletePersonMutation.isError || roleMutation.isError || resetFailed;
  const hasPersonActions = canEditPerson || canEditAccount || canCreateAccount ||
    canAssignRole || canSetPassword || canIssuePasswordReset || canInvite ||
    canIssuePINSetup;

  return (
    <Stack gap={7} className="person-detail-page">
      <PageHeader
        title={`${person.firstName} ${person.lastName}`}
        breadcrumbs={[
          { label: 'Settings', to: '/settings' },
          { label: 'People', to: '/settings/users' },
          { label: `${person.firstName} ${person.lastName}` },
        ]}
        description="Personal details, account access, and Makerspace status."
        actions={canViewSupervisorStaffing || hasPersonActions ? (
          <div className="button-cluster">
            {canViewSupervisorStaffing && (
              <Button kind="tertiary" onClick={() => navigate('/settings/users/staffing')}>
                Supervisor staffing
              </Button>
            )}
            {hasPersonActions && (
            <MenuButton label="Actions" kind="tertiary" menuAlignment="bottom-end" size="md">
              {canEditPerson && !editingPerson && (
                <MenuItem label="Edit person" onClick={() => setEditingPerson(true)} />
              )}
              {canEditPerson && !editingPerson && (hasAccountActions || hasCredentialActions) && (
                <MenuItemDivider />
              )}
              {canEditAccount && (
                <MenuItem label="Edit account" onClick={() => setEditingEmail(true)} />
              )}
              {canCreateAccount && (
                <MenuItem label="Create account" onClick={() => setCreateAccountOpen(true)} />
              )}
              {canAssignRole && (
                <MenuItem label="Assign role" onClick={() => setAssignRoleOpen(true)} />
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
			  {canIssuePINSetup && (
				<MenuItem label={activePINIdentity ? 'Reset PIN login' : 'Add PIN login'} onClick={() => setConfirmKind('pin-setup')} />
			  )}
            </MenuButton>
            )}
          </div>
        ) : undefined}
      />
      {mutationError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Change not completed" subtitle="The record may have changed. Reload it and try again." />
      )}
      <div className="person-detail-layout">
        <Grid condensed className="person-detail-grid">
          <Column sm={4} md={3} lg={4}>
            <Stack gap={6}>
              <Tile className="person-detail-card person-profile-card">
                <Stack gap={5}>
                  <h2>Profile picture</h2>
                  <ProfilePictureEditor
                    id="person-profile-image"
                    firstName={person.firstName}
                    lastName={person.lastName}
                    profileImage={person.profileImage}
                    canUpdate={canUpdateProfileImage}
                    canRemove={canRemoveProfileImage}
                    isUploading={profileImageMutation.isPending}
                    isRemoving={removeProfileImageMutation.isPending}
                    onUpload={(file) => profileImageMutation.mutate(file)}
                    onRemove={() => removeProfileImageMutation.mutate()}
                  />
                  <p className="person-profile-card__name">{person.firstName} {person.lastName}</p>
                  {person.profileImageRequired && !person.profileImage && (
                    <InlineNotification kind="warning" lowContrast hideCloseButton title="Profile picture required" subtitle="At least one assigned role requires a profile picture." />
                  )}
                  {profileImageMutation.isError && (
                    <InlineNotification kind="error" lowContrast hideCloseButton title="Picture not updated" subtitle="Use a JPEG, PNG, or WebP image up to 8 MiB and 4096×4096 pixels." />
                  )}
                </Stack>
              </Tile>

              <Tile className="person-detail-card">
                <Stack gap={6}>
                  <h2>Personal information</h2>
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
                </Stack>
              </Tile>
            </Stack>
          </Column>

          <Column sm={4} md={5} lg={12}>
            <Stack gap={6}>
              <Tile className="person-detail-card">
                <Stack gap={6}>
                  <div className="section-heading"><h2>Account access</h2>{account && <Tag type={account.status === 'enabled' ? 'green' : 'gray'}>{account.status === 'enabled' ? 'Enabled' : 'Disabled'}</Tag>}</div>
                  {!canReadAccounts || person.account === undefined ? (
                    <InlineNotification kind="info" lowContrast hideCloseButton title="Account details unavailable" subtitle="Your permissions do not include account access." />
                  ) : !account ? (
                    <p>This person does not have a login account.</p>
                  ) : (
                    <Stack gap={5}>
                      {editingEmail ? (
                        <Form onSubmit={submitEmail}>
                          <Stack gap={5}>
                            <TextInput id="account-login-email" type="email" labelText="Login email" invalid={Boolean(accountEmailForm.formState.errors.loginEmail)} invalidText={accountEmailForm.formState.errors.loginEmail?.message} {...accountEmailForm.register('loginEmail', { required: 'Enter a login email.' })} />
                            <div className="form-actions"><Button kind="secondary" type="button" onClick={() => setEditingEmail(false)}>Cancel</Button><Button type="submit" disabled={emailMutation.isPending}>Save</Button></div>
                          </Stack>
                        </Form>
                      ) : (
                        <StructuredListWrapper isCondensed>
                          <StructuredListBody>
                            <DetailRow label="Login email" value={account.loginEmail ?? 'Not configured'} />
                            <DetailRow label="Account source" value={formatProvisioningSource(account.provisioningSource)} />
                            <DetailRow label="First sign-in" value={account.firstAuthenticatedAt ? new Date(account.firstAuthenticatedAt).toLocaleString() : 'Not yet'} />
                            <DetailRow label="Account ID" value={account.id} monospace />
                          </StructuredListBody>
                        </StructuredListWrapper>
                      )}
                      {account.status === 'disabled' && hasPermission(currentUser, PermissionId.accountsenable) && (
                        <div>
                          <Button size="sm" disabled={account.passwordStatus !== 'active' || enableMutation.isPending} onClick={() => enableMutation.mutate()}>Enable account</Button>
                          {account.passwordStatus !== 'active' && <p className="section-description">An active password is required before this account can be enabled.</p>}
                        </div>
                      )}
                    </Stack>
                  )}
                </Stack>
              </Tile>

              {account && (
                <Tile className="person-detail-card">
                  <Stack gap={6}>
                    <h2>Authentication methods</h2>
                    <div className="authentication-methods">
                      <AuthenticationMethod
                        label="Local password"
                        status={account.passwordStatus === 'active' ? 'Active' : account.passwordStatus === 'reset_required' ? 'Reset required' : 'Not configured'}
                        active={account.passwordStatus === 'active'}
                        warning={account.passwordStatus === 'reset_required'}
                      />
                      <AuthenticationMethod
                        label="Username and PIN"
                        status={activePINIdentity ? 'Active' : 'Not configured'}
                        detail={activePINIdentity?.displayIdentifier ? `Username: ${activePINIdentity.displayIdentifier}` : undefined}
                        active={Boolean(activePINIdentity)}
                      />
                      <AuthenticationMethod
                        label="OIDC / SSO"
                        status={activeOIDCIdentities.length ? `${activeOIDCIdentities.length} linked` : 'Not connected'}
                        active={activeOIDCIdentities.length > 0}
                      >
                        {activeOIDCIdentities.map((identity) => (
                          <div className="authentication-method__identity" key={identity.id}>
                            <span>{identity.displayIdentifier ?? 'OIDC provider'}</span>
                            {identity.providerSlug && <code>{identity.providerSlug}</code>}
                          </div>
                        ))}
                      </AuthenticationMethod>
                    </div>
                  </Stack>
                </Tile>
              )}

              {account && (
                <Tile className="person-detail-card">
                  <Stack gap={5}>
                    <div className="section-heading">
                      <h2>Roles</h2>
                      <div className="tag-list">
                        <span className="section-description">{account.roles.length} assigned</span>
                        {supervisorRoleNames.length > 0 && <Tag type="blue">Supervisor</Tag>}
                      </div>
                    </div>
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
                    {supervisorRoleNames.length > 0 && (
                      <p className="section-description">
                        Included in supervisor staffing through {supervisorRoleNames.join(', ')}.
                      </p>
                    )}
                  </Stack>
                </Tile>
              )}
            </Stack>
          </Column>
        </Grid>

        {canReadMakerspaceStatus && (
          <Tile className="person-detail-card person-makerspace-card">
            <Stack gap={6}>
              <div><h2>Makerspace status</h2><p className="section-description">Upcoming participation and current Lab Rules acknowledgement.</p></div>
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
            </Stack>
          </Tile>
        )}

      {resetSent && (
        <Tile className="secret-tile">
          <Stack gap={5}>
            <InlineNotification kind="success" lowContrast hideCloseButton title={manualSetupUrl ? 'Manual setup link created' : 'Message sent'} subtitle={manualSetupUrl ? 'Mail is not configured. Copy this one-time link and deliver it to the intended recipient through a trusted channel.' : 'The one-time link was sent by email.'} />
            {manualSetupUrl && <><TextInput id="manual-setup-url" labelText="One-time setup link" readOnly value={`${window.location.origin}${manualSetupUrl}`} /><Button kind="secondary" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${manualSetupUrl}`)}>Copy link</Button></>}
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
        <ModalHeader title="Create login account" label={`${person.firstName} ${person.lastName}`} />
        <ModalBody>
          <Form id="create-account-form" onSubmit={submitCreateAccount}>
            <Stack gap={5}>
              {createAccountMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Account not created" subtitle="Check the email and try again." />}
              <TextInput id="new-account-email" type="email" labelText="Login email" invalid={Boolean(accountCreateForm.formState.errors.loginEmail)} invalidText={accountCreateForm.formState.errors.loginEmail?.message} {...accountCreateForm.register('loginEmail', { required: 'Enter a login email.' })} />
              <p className="section-description">New accounts are disabled until a password is set.</p>
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter><Button kind="secondary" onClick={() => setCreateAccountOpen(false)}>Cancel</Button><Button type="submit" form="create-account-form" disabled={createAccountMutation.isPending}>Create account</Button></ModalFooter>
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
        <ModalHeader title="Set account password" label={account?.loginEmail ?? undefined} />
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

      <ComposedModal open={Boolean(selectedConfirmation)} danger onClose={() => setConfirmKind(null)}>
        <ModalHeader title={selectedConfirmation?.[0] ?? ''} />
        <ModalBody><p>{selectedConfirmation?.[1]}</p>{resetFailed && (confirmKind === 'reset-password' || confirmKind === 'invite' || confirmKind === 'pin-setup') && <InlineNotification kind="error" lowContrast hideCloseButton title="Message not sent" subtitle="Reload the account and try again." />}</ModalBody>
        <ModalFooter><Button kind="secondary" onClick={() => setConfirmKind(null)}>Cancel</Button><Button kind="danger" disabled={resetPending || deletePersonMutation.isPending || deleteAccountMutation.isPending || disableMutation.isPending} onClick={() => void confirmAction()}>{selectedConfirmation?.[2] ?? 'Confirm'}</Button></ModalFooter>
      </ComposedModal>
    </Stack>
  );
}

function DetailRow({ label, value, monospace = false }: { label: string; value: string; monospace?: boolean }) {
  return <StructuredListRow><StructuredListCell>{label}</StructuredListCell><StructuredListCell>{monospace ? <code>{value}</code> : value}</StructuredListCell></StructuredListRow>;
}

function AuthenticationMethod({
  label,
  status,
  detail,
  active,
  warning = false,
  children,
}: {
  label: string;
  status: string;
  detail?: string;
  active: boolean;
  warning?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="authentication-method">
      <div className="authentication-method__header">
        <div><strong>{label}</strong>{detail && <span>{detail}</span>}</div>
        <Tag type={warning ? 'warm-gray' : active ? 'green' : 'gray'}>{status}</Tag>
      </div>
      {children}
    </div>
  );
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

function formatProvisioningSource(source: string): string {
  return source.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
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
