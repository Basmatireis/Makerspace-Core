import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  Column,
  ComposedModal,
  Dropdown,
  Form,
  Grid,
  InlineNotification,
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
import { Add, Copy, Edit, Password, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router-dom';
import {
  assignAccountRole,
  createPersonAccount,
  deleteAccount,
  disableAccount,
  enableAccount,
  getAccount,
  issueAccountPasswordReset,
  removeAccountRole,
  setAccountPassword,
  updateAccountLoginEmail,
} from '../../api/generated/accounts/accounts';
import type {
  Account,
  AccountSummary,
  Person,
  Role,
  UpdatePersonRequest,
} from '../../api/generated/models';
import { deletePerson, updatePerson } from '../../api/generated/people/people';
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

type ConfirmKind = 'delete-person' | 'delete-account' | 'disable-account' | 'reset-password' | null;
type AccountEmailForm = { loginEmail: string };
type AccountPasswordForm = { newPassword: string; confirmPassword: string };

function asAccount(value: Person['account']): AccountSummary | undefined {
  return value && typeof value === 'object' ? value : undefined;
}

export function UserDetailPage() {
  const { personId = '' } = useParams();
  const personQuery = useQuery(personOptions(personId));

  if (personQuery.isPending) return <FullPageLoading label="Loading member" />;
  if (personQuery.isError || !personQuery.data) {
    return (
      <ErrorState
        title="Unable to load member"
        message="The member may no longer exist or you may not have access."
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
  const accountQuery = useQuery({
    queryKey: ['accounts', 'detail', accountSummary?.id],
    queryFn: ({ signal }) => getAccount(accountSummary!.id, { signal }),
    enabled: Boolean(accountSummary && hasPermission(currentUser, PermissionId.accountsread)),
  });
  const account: Account | AccountSummary | undefined = accountQuery.data ?? accountSummary;
  const [editingPerson, setEditingPerson] = useState(false);
  const [editingEmail, setEditingEmail] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const [confirmKind, setConfirmKind] = useState<ConfirmKind>(null);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [secretResetUrl, setSecretResetUrl] = useState<string | null>(null);
  const [resetExpiresAt, setResetExpiresAt] = useState<string | null>(null);
  const [resetPending, setResetPending] = useState(false);
  const [resetFailed, setResetFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const createAccountButtonRef = useRef<HTMLButtonElement>(null);
  const passwordButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationLauncherRef = useRef<HTMLButtonElement>(null);

  useEffect(() => () => setSecretResetUrl(null), []);

  const clearResetIssue = () => {
    setSecretResetUrl(null);
    setResetExpiresAt(null);
    setCopied(false);
  };

  const canEditPerson = canUpdatePerson(currentUser, person.id);
  const canReadMatriculation = hasPermission(currentUser, PermissionId.peoplereadmatriculation);
  const canEditMatriculation = canReadMatriculation && hasPermission(currentUser, PermissionId.peopleupdatematriculation);
  const canReadAccounts = hasPermission(currentUser, PermissionId.accountsread);
  const canAssignRoles = hasPermission(currentUser, PermissionId.accountsrolesassign);
  const canReadRoles = hasPermission(currentUser, PermissionId.rolesread);
  const canDeletePerson = hasPermission(currentUser, PermissionId.peopledelete) &&
    (hasPermission(currentUser, PermissionId.accountsdelete) ||
      (canReadAccounts && person.account === null));

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

  const refresh = async (updatedAccount?: Account) => {
    if (updatedAccount) {
      queryClient.setQueryData(['accounts', 'detail', updatedAccount.id], updatedAccount);
    }
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
    onSuccess: async (created) => {
      setCreateAccountOpen(false);
      accountCreateForm.reset({ loginEmail: '' });
      await refresh(created);
    },
  });
  const emailMutation = useMutation({
    mutationFn: ({ loginEmail }: AccountEmailForm) => updateAccountLoginEmail(account!.id, { loginEmail: loginEmail.trim(), expectedVersion: account!.version }),
    onSuccess: async (updated) => {
      setEditingEmail(false);
      await refresh(updated);
    },
  });
  const passwordMutation = useSecretMutation(
    ({ newPassword }: AccountPasswordForm) => setAccountPassword(account!.id, { newPassword, expectedVersion: account!.version }),
    {
    onSuccess: async (updated) => {
      accountPasswordForm.reset();
      clearResetIssue();
      setPasswordModalOpen(false);
      await refresh(updated);
    },
    },
  );
  const enableMutation = useMutation({ mutationFn: () => enableAccount(account!.id, { expectedVersion: account!.version }), onSuccess: refresh });
  const disableMutation = useMutation({ mutationFn: () => disableAccount(account!.id, { expectedVersion: account!.version }), onSuccess: async (updated) => { setConfirmKind(null); await refresh(updated); } });
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
    onSuccess: async (updated) => {
      setSelectedRole(null);
      await Promise.all([
        refresh(updated),
        queryClient.invalidateQueries({ queryKey: authQueryKey }),
      ]);
    },
  });

  const rolesQuery = useQuery({ ...fullRoleCatalogOptions, enabled: Boolean(account && canAssignRoles && canReadRoles) });
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

  const confirmAction = async () => {
    try {
      if (confirmKind === 'delete-person') await deletePersonMutation.mutateAsync();
      if (confirmKind === 'delete-account') await deleteAccountMutation.mutateAsync();
      if (confirmKind === 'disable-account') await disableMutation.mutateAsync();
      if (confirmKind === 'reset-password' && account) {
        setResetPending(true);
        setResetFailed(false);
        const issue = await issueAccountPasswordReset(account.id, { expectedVersion: account.version });
        setSecretResetUrl(issue.resetUrl);
        setResetExpiresAt(issue.expiresAt);
        queryClient.setQueryData(['accounts', 'detail', issue.account.id], issue.account);
        await refresh(issue.account);
        setConfirmKind(null);
      }
    } catch {
      if (confirmKind === 'reset-password') setResetFailed(true);
    } finally {
      setResetPending(false);
    }
  };

  const confirmation = {
    'delete-person': ['Delete member permanently?', 'This permanently deletes the member and, if present, their account. This cannot be undone.', 'Delete member'],
    'delete-account': ['Delete account permanently?', 'The member record remains, but the login account is permanently removed.', 'Delete account'],
    'disable-account': ['Disable this account?', 'The user will be signed out and will not be able to sign in.', 'Disable account'],
    'reset-password': ['Issue a password reset link?', 'The current password and sessions will be invalidated. The link is shown only once.', 'Issue reset link'],
  } as const;
  const selectedConfirmation = confirmKind ? confirmation[confirmKind] : null;
  const mutationError = personMutation.isError || createAccountMutation.isError || emailMutation.isError || passwordMutation.isError || enableMutation.isError || disableMutation.isError || deleteAccountMutation.isError || deletePersonMutation.isError || roleMutation.isError || resetFailed;

  return (
    <Stack gap={7}>
      <PageHeader
        title={`${person.firstName} ${person.lastName}`}
        breadcrumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Members', to: '/settings/users' }]}
        description="Member details and account access."
        actions={canDeletePerson ? (
          <Button kind="danger--tertiary" renderIcon={TrashCan} onClick={(event) => { confirmationLauncherRef.current = event.currentTarget; setConfirmKind('delete-person'); }}>Delete member</Button>
        ) : undefined}
      />
      {mutationError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Change not completed" subtitle="The record may have changed. Reload it and try again." />
      )}
      <Grid condensed>
        <Column sm={4} md={8} lg={8}>
          <Tile>
            <Stack gap={6}>
              <div className="section-heading">
                <h2>Personal information</h2>
                {canEditPerson && !editingPerson && <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setEditingPerson(true)}>Edit</Button>}
              </div>
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
                    <DetailRow label="Contact email" value={person.email ?? 'Not provided'} />
                    <DetailRow label="Phone" value={person.phone ?? 'Not provided'} />
                    {canReadMatriculation && <DetailRow label="Matriculation number" value={person.matriculationNumber ?? 'Not provided'} />}
                  </StructuredListBody>
                </StructuredListWrapper>
              )}
            </Stack>
          </Tile>
        </Column>

        <Column sm={4} md={8} lg={8}>
          <Tile>
            <Stack gap={6}>
              <div className="section-heading"><h2>Login account</h2></div>
              {!canReadAccounts || person.account === undefined ? (
                <InlineNotification kind="info" lowContrast hideCloseButton title="Account details unavailable" subtitle="Your permissions do not include account access." />
              ) : !account ? (
                <Stack gap={4}>
                  <p>This member does not have a login account.</p>
                  {hasPermission(currentUser, PermissionId.accountscreate) && <Button ref={createAccountButtonRef} renderIcon={Add} onClick={() => setCreateAccountOpen(true)}>Create account</Button>}
                </Stack>
              ) : (
                <Stack gap={6}>
                  <div className="account-summary">
                    <div><span className="label">Status</span><Tag type={account.status === 'enabled' ? 'green' : 'gray'}>{account.status}</Tag></div>
                    <div><span className="label">Password</span><Tag type={account.passwordStatus === 'active' ? 'green' : 'warm-gray'}>{account.passwordStatus.replace('_', ' ')}</Tag></div>
                  </div>
                  {editingEmail ? (
                    <Form onSubmit={submitEmail}>
                      <Stack gap={5}>
                        <TextInput id="account-login-email" type="email" labelText="Login email" invalid={Boolean(accountEmailForm.formState.errors.loginEmail)} invalidText={accountEmailForm.formState.errors.loginEmail?.message} {...accountEmailForm.register('loginEmail', { required: 'Enter a login email.' })} />
                        <div className="form-actions"><Button kind="secondary" type="button" onClick={() => setEditingEmail(false)}>Cancel</Button><Button type="submit" disabled={emailMutation.isPending}>Save</Button></div>
                      </Stack>
                    </Form>
                  ) : (
                    <div className="section-heading"><div><span className="label">Login email</span><p>{account.loginEmail}</p></div>{hasPermission(currentUser, PermissionId.accountslogin_emailupdate) && <Button kind="ghost" size="sm" onClick={() => setEditingEmail(true)}>Change</Button>}</div>
                  )}
                  <div className="tag-list" aria-label="Assigned roles">
                    {account.roles.length === 0 && <span>No roles assigned</span>}
                    {account.roles.map((role) => {
                      const roleDetails = rolesById.get(role.id);
                      const mayRemove = Boolean(
                        roleDetails && canManageRoleMembership(currentUser, roleDetails),
                      );
                      return <Tag key={role.id} type={role.systemKey === 'master' ? 'purple' : 'blue'} filter={mayRemove} onClose={mayRemove ? () => roleMutation.mutate({ roleId: role.id, remove: true }) : undefined}>{role.name}</Tag>;
                    })}
                  </div>
                  {canAssignRoles && canReadRoles && rolesQuery.isPending && (
                    <InlineLoadingState label="Loading role catalog" />
                  )}
                  {canAssignRoles && canReadRoles && rolesQuery.isError && (
                    <Stack gap={4}>
                      <InlineNotification
                        kind="error"
                        lowContrast
                        hideCloseButton
                        title="Role catalog unavailable"
                        subtitle="Roles cannot be assigned or removed until the catalog loads."
                      />
                      <Button kind="tertiary" size="sm" onClick={() => void rolesQuery.refetch()}>
                        Try again
                      </Button>
                    </Stack>
                  )}
                  {canAssignRoles && canReadRoles && rolesQuery.data && assignableRoles.length > 0 && (
                    <div className="role-assignment">
                      <Dropdown id="assign-role" titleText="Assign role" label="Choose a role" items={assignableRoles} itemToString={(item) => item?.name ?? ''} selectedItem={selectedRole} onChange={({ selectedItem }) => setSelectedRole(selectedItem ?? null)} />
                      <Button disabled={!selectedRole || roleMutation.isPending} onClick={() => selectedRole && roleMutation.mutate({ roleId: selectedRole.id, remove: false })}>Assign</Button>
                    </div>
                  )}
                  {canAssignRoles && canReadRoles && rolesQuery.data && assignableRoles.length === 0 && (
                    <p className="section-description">No additional roles are available.</p>
                  )}
                  {canAssignRoles && !canReadRoles && <p className="section-description">Role assignment needs permission to view the role catalog.</p>}
                  <div className="button-cluster">
                    {hasPermission(currentUser, PermissionId.accountspasswordset) && <Button ref={passwordButtonRef} kind="secondary" renderIcon={Password} onClick={() => setPasswordModalOpen(true)}>Set password</Button>}
                    {hasPermission(currentUser, PermissionId.accountspasswordreset) && <Button kind="secondary" onClick={(event) => { confirmationLauncherRef.current = event.currentTarget; setConfirmKind('reset-password'); }}>Issue reset link</Button>}
                    {account.status === 'disabled' && hasPermission(currentUser, PermissionId.accountsenable) && <Button disabled={account.passwordStatus !== 'active' || enableMutation.isPending} onClick={() => enableMutation.mutate()}>Enable</Button>}
                    {account.status === 'enabled' && hasPermission(currentUser, PermissionId.accountsdisable) && <Button kind="danger--tertiary" onClick={(event) => { confirmationLauncherRef.current = event.currentTarget; setConfirmKind('disable-account'); }}>Disable</Button>}
                    {hasPermission(currentUser, PermissionId.accountsdelete) && <Button kind="danger--tertiary" onClick={(event) => { confirmationLauncherRef.current = event.currentTarget; setConfirmKind('delete-account'); }}>Delete account</Button>}
                  </div>
                  {account.status === 'disabled' && account.passwordStatus !== 'active' && hasPermission(currentUser, PermissionId.accountsenable) && <p className="section-description">Set an active password before enabling this account.</p>}
                </Stack>
              )}
            </Stack>
          </Tile>
        </Column>
      </Grid>

      {secretResetUrl && (
        <Tile className="secret-tile">
          <Stack gap={5}>
            <InlineNotification kind="warning" lowContrast hideCloseButton title="Copy this reset link now" subtitle="It is shown only once. Treat it like a password." />
            <TextInput id="issued-reset-url" labelText="One-time reset URL" readOnly value={secretResetUrl} />
            {resetExpiresAt && <p className="section-description">Expires {new Date(resetExpiresAt).toLocaleString()}.</p>}
            <div className="form-actions">
              <Button kind="secondary" renderIcon={Copy} onClick={async () => { await navigator.clipboard.writeText(secretResetUrl); setCopied(true); }}>{copied ? 'Copied' : 'Copy link'}</Button>
              <Button kind="ghost" onClick={clearResetIssue}>Dismiss permanently</Button>
            </div>
          </Stack>
        </Tile>
      )}

      <ComposedModal open={createAccountOpen} launcherButtonRef={createAccountButtonRef} onClose={() => setCreateAccountOpen(false)}>
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

      <ComposedModal open={passwordModalOpen} launcherButtonRef={passwordButtonRef} onClose={() => { accountPasswordForm.reset(); passwordMutation.reset(); setPasswordModalOpen(false); }}>
        <ModalHeader title="Set account password" label={account?.loginEmail} />
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

      <ComposedModal open={Boolean(selectedConfirmation)} danger launcherButtonRef={confirmationLauncherRef} onClose={() => setConfirmKind(null)}>
        <ModalHeader title={selectedConfirmation?.[0] ?? ''} />
        <ModalBody><p>{selectedConfirmation?.[1]}</p>{resetFailed && confirmKind === 'reset-password' && <InlineNotification kind="error" lowContrast hideCloseButton title="Reset link not issued" subtitle="Reload the account and try again." />}</ModalBody>
        <ModalFooter><Button kind="secondary" onClick={() => setConfirmKind(null)}>Cancel</Button><Button kind="danger" disabled={resetPending || deletePersonMutation.isPending || deleteAccountMutation.isPending || disableMutation.isPending} onClick={() => void confirmAction()}>{selectedConfirmation?.[2] ?? 'Confirm'}</Button></ModalFooter>
      </ComposedModal>
    </Stack>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <StructuredListRow><StructuredListCell>{label}</StructuredListCell><StructuredListCell>{value}</StructuredListCell></StructuredListRow>;
}
