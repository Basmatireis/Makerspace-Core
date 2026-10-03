import { useState } from 'react';
import {
  Button,
  Column,
  ComposedModal,
  CopyButton,
  Form,
  Grid,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  OverflowMenu,
  OverflowMenuItem,
  PasswordInput,
  Stack,
  StructuredListBody,
  StructuredListWrapper,
  Tag,
  TextInput,
} from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { formatDateTime } from '../../app/dateTime';
import { changeOwnPassword, enrollOwnPin, removeOwnPassword, removeOwnPin, requestOwnEmailVerification } from '../../api/generated/authentication/authentication';
import { updatePerson } from '../../api/generated/people/people';
import { deletePersonProfileImage, getPutPersonProfileImageUrl } from '../../api/generated/people/people';
import type { OIDCLoginProvider, ProfileImage, UpdatePersonRequest } from '../../api/generated/models';
import { apiFetch } from '../../api/http-client';
import { listOIDCLoginProviders, startOIDCLink, startOIDCReauthentication, unlinkOwnOIDCIdentity } from '../../api/generated/oidc/oidc';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { authQueryKey, useCurrentUser } from '../auth/auth';
import { validatePasswordLength } from '../auth/password-validation';
import {
  canUpdatePerson,
  hasPermission,
  PermissionId,
} from '../auth/permissions';
import { PersonFields, type PersonFormValues, toPersonPatch } from '../users/PersonForm';
import {
  AuthenticationMethod,
  DetailRow,
  DetailSection,
} from '../users/PersonDetailComponents';
import { PersonAvatar } from '../users/PersonAvatar';
import { ProfilePictureEditor } from '../users/ProfilePictureEditor';

type PasswordFormValues = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};
type RemovePasswordFormValues = { currentPassword: string };
type PINFormValues = { loginName: string; pin: string; confirmPIN: string };
type OIDCLinkFormValues = { currentPassword: string };

export function ProfilePage() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const [editingProfile, setEditingProfile] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [removePasswordModalOpen, setRemovePasswordModalOpen] = useState(false);
  const [pinModalOpen, setPINModalOpen] = useState(false);
  const [removePINModalOpen, setRemovePINModalOpen] = useState(false);
  const [oidcProviderToLink, setOIDCProviderToLink] = useState<OIDCLoginProvider | null>(null);
  const personForm = useForm<PersonFormValues>({
    defaultValues: {
      firstName: currentUser.person.firstName,
      lastName: currentUser.person.lastName,
      email: currentUser.person.email ?? '',
      phone: currentUser.person.phone ?? '',
      matriculationNumber: currentUser.person.matriculationNumber ?? '',
    },
  });
  const passwordForm = useForm<PasswordFormValues>({
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });
  const removePasswordForm = useForm<RemovePasswordFormValues>({ defaultValues: { currentPassword: '' } });
  const pinForm = useForm<PINFormValues>({ defaultValues: { loginName: '', pin: '', confirmPIN: '' } });
  const oidcLinkForm = useForm<OIDCLinkFormValues>({ defaultValues: { currentPassword: '' } });
  const oidcProviders = useQuery({ queryKey: ['oidc', 'login-providers'], queryFn: ({ signal }) => listOIDCLoginProviders({ signal }) });

  const updateProfileMutation = useMutation({
    mutationFn: (request: UpdatePersonRequest) =>
      updatePerson(currentUser.person.id, request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: authQueryKey });
      setEditingProfile(false);
    },
  });
  const passwordMutation = useSecretMutation(
    (request: Parameters<typeof changeOwnPassword>[0]) =>
      changeOwnPassword(request),
    { onSuccess: () => { passwordForm.reset(); setPasswordModalOpen(false); } },
  );
  const removePasswordMutation = useSecretMutation(
    (currentPassword: string) => removeOwnPassword({ currentPassword }),
    { onSuccess: () => window.location.assign('/login') },
  );
  const pinMutation = useSecretMutation(
    ({ loginName, pin }: PINFormValues) => enrollOwnPin({ loginName, pin }),
    { onSuccess: async () => { pinForm.reset(); setPINModalOpen(false); await queryClient.invalidateQueries({ queryKey: authQueryKey }); } },
  );
  const removePINMutation = useMutation({
    mutationFn: () => removeOwnPin(),
    onSuccess: async () => { setRemovePINModalOpen(false); await queryClient.invalidateQueries({ queryKey: authQueryKey }); },
  });
	const emailVerificationMutation = useMutation({ mutationFn: () => requestOwnEmailVerification() });
  const linkOIDCMutation = useSecretMutation(
    ({ slug, currentPassword }: { slug: string; currentPassword: string }) => startOIDCLink(slug, currentPassword ? { currentPassword } : {}),
    { onSuccess: (flow) => { oidcLinkForm.reset(); setOIDCProviderToLink(null); window.location.assign(flow.authorizationUrl); } },
  );
  const reauthenticateOIDCMutation = useMutation({
    mutationFn: (slug: string) => startOIDCReauthentication(slug),
    onSuccess: (flow) => window.location.assign(flow.authorizationUrl),
  });
  const unlinkOIDCMutation = useMutation({
    mutationFn: (identityId: string) => unlinkOwnOIDCIdentity(identityId),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: authQueryKey }),
  });
	const profileImageMutation = useMutation({
		mutationFn: (file: File) => apiFetch<ProfileImage>(
			getPutPersonProfileImageUrl(currentUser.person.id, { expectedVersion: currentUser.person.version }),
			{ method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': file.name, 'X-Profile-Image-Source': 'self_upload' }, body: file },
		),
		onSuccess: async () => queryClient.invalidateQueries({ queryKey: authQueryKey }),
	});
	const removeProfileImageMutation = useMutation({
		mutationFn: () => deletePersonProfileImage(currentUser.person.id, { expectedVersion: currentUser.person.version }),
		onSuccess: async () => queryClient.invalidateQueries({ queryKey: authQueryKey }),
	});

  const mayEdit = canUpdatePerson(currentUser, currentUser.person.id);
  const mayReadMatriculation = hasPermission(
    currentUser,
    PermissionId.peoplereadmatriculation,
  );
  const mayEditMatriculation =
    mayReadMatriculation &&
    hasPermission(currentUser, PermissionId.peopleupdatematriculation);
  const mayEnrollPIN = hasPermission(currentUser, PermissionId.accountspinenrollself);
  const mayRemovePIN = hasPermission(currentUser, PermissionId.accountspinremoveself);
	const mayRemovePassword = hasPermission(currentUser, PermissionId.accountspasswordremoveself);
	const mayLinkOIDC = hasPermission(currentUser, PermissionId.identitiesoidclinkself);
	const mayUnlinkOIDC = hasPermission(currentUser, PermissionId.identitiesoidcunlinkself);
	const mayUpdateProfileImage = hasPermission(currentUser, PermissionId.peopleprofile_imageupdateself);
	const mayRemoveProfileImage = hasPermission(currentUser, PermissionId.peopleprofile_imageremoveself);
  const pinIdentity = currentUser.account.authIdentities.find((identity) => identity.kind === 'pin');
	const passwordIdentity = currentUser.account.authIdentities.find((identity) => identity.kind === 'password');
  const oidcIdentities = currentUser.account.authIdentities.filter((identity) => identity.kind === 'oidc');
  const hasUsableAuthenticationMethod = currentUser.account.authIdentities.some((identity) => identity.usable);
  const freshEnoughForMethods = currentUser.authenticationAssurance !== 'low';

  const submitProfile = personForm.handleSubmit(async (values) => {
    const patch = toPersonPatch(
      values,
      personForm.formState.dirtyFields,
      currentUser.person.version,
      mayEditMatriculation,
    );
    try {
      await updateProfileMutation.mutateAsync(patch);
    } catch {
      // The mutation state renders the safe inline error.
    }
  });
  const submitPassword = passwordForm.handleSubmit(
    async ({ currentPassword, newPassword }) => {
      try {
        await passwordMutation.mutateAsync({ currentPassword, newPassword });
      } catch {
        // Session expiry is handled globally; other failures render below.
      }
    },
  );
  const submitPIN = pinForm.handleSubmit(async (values) => {
    try { await pinMutation.mutateAsync(values); } catch { /* rendered below */ }
  });
  const submitRemovePassword = removePasswordForm.handleSubmit(async ({ currentPassword }) => {
    try { await removePasswordMutation.mutateAsync(currentPassword); } catch { /* rendered in modal */ }
  });
  const submitOIDCLink = oidcLinkForm.handleSubmit(async ({ currentPassword }) => {
    if (!oidcProviderToLink) return;
    try {
      await linkOIDCMutation.mutateAsync({ slug: oidcProviderToLink.slug, currentPassword });
    } catch { /* rendered in modal */ }
  });

  const closePasswordModal = () => {
    passwordForm.reset();
    passwordMutation.reset();
    setPasswordModalOpen(false);
  };
  const closeRemovePasswordModal = () => {
    removePasswordForm.reset();
    removePasswordMutation.reset();
    setRemovePasswordModalOpen(false);
  };
  const closePINModal = () => {
    pinForm.reset({ loginName: pinIdentity?.displayIdentifier ?? '', pin: '', confirmPIN: '' });
    pinMutation.reset();
    setPINModalOpen(false);
  };
  const closeOIDCLinkModal = () => {
    oidcLinkForm.reset();
    linkOIDCMutation.reset();
    setOIDCProviderToLink(null);
  };

  return (
    <PageShell
      title="Profile"
      description="Review your personal information and account security."
      className="person-detail-page"
    >

      <div className="person-detail-layout">
        <Grid className="person-detail-grid person-detail-grid--overview">
          <Column sm={4} md={3} lg={6} className="person-detail-grid__stretch-cell">
            <DetailSection
              title="Profile picture"
              className="person-profile-card"
              headingContent={(
                <div className="person-profile-card__identity">
                  <PersonAvatar
                    firstName={currentUser.person.firstName}
                    lastName={currentUser.person.lastName}
                    profileImage={currentUser.person.profileImage}
                    size="lg"
                  />
                </div>
              )}
              action={(mayUpdateProfileImage || (currentUser.person.profileImage && mayRemoveProfileImage)) ? (
                <ProfilePictureEditor
                  id="own-profile-image"
                  firstName={currentUser.person.firstName}
                  lastName={currentUser.person.lastName}
                  profileImage={currentUser.person.profileImage}
                  canUpdate={mayUpdateProfileImage}
                  canRemove={mayRemoveProfileImage}
                  isUploading={profileImageMutation.isPending}
                  isRemoving={removeProfileImageMutation.isPending}
                  trigger="button"
                  onUpload={(file) => profileImageMutation.mutate(file)}
                  onRemove={() => removeProfileImageMutation.mutate()}
                />
              ) : undefined}
            >
              {currentUser.person.profileImageRequired && !currentUser.person.profileImage && (
                <InlineNotification kind="warning" lowContrast hideCloseButton title="Profile picture required" subtitle="At least one assigned role requires a profile picture." />
              )}
              {profileImageMutation.isError && (
                <InlineNotification kind="error" lowContrast hideCloseButton title="Picture not updated" subtitle="Use a JPEG, PNG, or WebP image up to 8 MiB and 4096×4096 pixels." />
              )}
            </DetailSection>
          </Column>

          <Column sm={4} md={5} lg={10} className="person-detail-grid__stretch-cell">
            <DetailSection
              title="Account access"
              meta={<Tag type={currentUser.account.status === 'enabled' ? 'green' : 'gray'}>{currentUser.account.status === 'enabled' ? 'Active' : 'Inactive'}</Tag>}
            >
              <StructuredListWrapper isCondensed>
                <StructuredListBody>
                  <DetailRow label="Account status" value={currentUser.account.status === 'enabled' ? 'Active' : 'Inactive'} />
                  <DetailRow label="Provisioning source" value={formatProvisioningSource(currentUser.account.provisioningSource)} />
                  <DetailRow label="First sign-in" value={currentUser.account.firstAuthenticatedAt ? formatDateTime(currentUser.account.firstAuthenticatedAt) : 'Not yet'} />
                  <DetailRow
                    label="Account ID"
                    value={currentUser.account.id}
                    monospace
                    action={(
                      <CopyButton
                        size="sm"
                        iconDescription="Copy account ID"
                        feedback="Account ID copied"
                        onClick={() => void navigator.clipboard.writeText(currentUser.account.id)}
                      />
                    )}
                  />
                </StructuredListBody>
              </StructuredListWrapper>
            </DetailSection>
          </Column>

          <Column sm={4} md={3} lg={6} className="person-detail-grid__stretch-cell">
            <DetailSection
              title="Personal information"
              action={mayEdit && !editingProfile ? (
                <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setEditingProfile(true)}>Edit</Button>
              ) : undefined}
            >
              {updateProfileMutation.isError && (
                <InlineNotification kind="error" lowContrast hideCloseButton title="Profile not updated" subtitle="Review the information and try again." />
              )}
              {editingProfile ? (
                <Form onSubmit={submitProfile}>
                  <Stack gap={6}>
                    <PersonFields form={personForm} showMatriculation={mayReadMatriculation} editMatriculation={mayEditMatriculation} />
                    <div className="form-actions">
                      <Button type="button" kind="secondary" onClick={() => { personForm.reset(); setEditingProfile(false); }}>Cancel</Button>
                      <Button type="submit" disabled={!personForm.formState.isDirty || updateProfileMutation.isPending}>{updateProfileMutation.isPending ? 'Saving…' : 'Save'}</Button>
                    </div>
                  </Stack>
                </Form>
              ) : (
                <StructuredListWrapper isCondensed>
                  <StructuredListBody>
                    <DetailRow label="First name" value={currentUser.person.firstName} />
                    <DetailRow label="Last name" value={currentUser.person.lastName} />
                    <DetailRow label="Contact email" value={currentUser.person.email ?? 'Not provided'} />
                    <DetailRow label="Phone" value={currentUser.person.phone ?? 'Not provided'} />
                    {mayReadMatriculation && <DetailRow label="Matriculation number" value={currentUser.person.matriculationNumber ?? 'Not provided'} />}
                  </StructuredListBody>
                </StructuredListWrapper>
              )}
            </DetailSection>
          </Column>

          <Column sm={4} md={5} lg={10} className="person-detail-overview__stack">
            <Stack gap={6}>
              <DetailSection
                title="Authentication methods"
                meta={!hasUsableAuthenticationMethod ? <Tag type="gray">No login methods</Tag> : undefined}
              >
                {!freshEnoughForMethods && (
                  <InlineNotification kind="info" lowContrast hideCloseButton title="Recent authentication required" subtitle="Use a password or an already linked OIDC provider before changing authentication methods. PIN alone is insufficient." />
                )}
                {passwordMutation.isSuccess && (
                  <InlineNotification kind="success" lowContrast hideCloseButton title="Password changed" subtitle="Your other sessions have been signed out." />
                )}
                {pinMutation.isSuccess && (
                  <InlineNotification kind="success" lowContrast hideCloseButton title="PIN method updated" subtitle="Other sessions were signed out." />
                )}
                {emailVerificationMutation.isSuccess && (
                  <InlineNotification kind="success" lowContrast hideCloseButton title="Verification code sent" subtitle="Check your login email and enter the code on the verification page." />
                )}
                {emailVerificationMutation.isError && (
                  <InlineNotification kind="error" lowContrast hideCloseButton title="Verification email not sent" subtitle="Email delivery may be unavailable. Try again later." />
                )}
                {reauthenticateOIDCMutation.isError && (
                  <InlineNotification kind="error" lowContrast hideCloseButton title="Reauthentication failed" subtitle="Use an enabled provider already linked to your account." />
                )}
                {unlinkOIDCMutation.isError && (
                  <InlineNotification kind="error" lowContrast hideCloseButton title="External identity not removed" subtitle="Try again after reauthenticating." />
                )}
                <div className="authentication-methods">
                  <AuthenticationMethod
                    label="Local password"
                    status={!passwordIdentity ? 'Not configured' : passwordIdentity.disabledAt ? 'Disabled' : passwordIdentity.usable ? 'Active' : currentUser.account.passwordStatus === 'reset_required' ? 'Reset required' : 'Not configured'}
                    detail={passwordIdentity?.displayIdentifier ?? undefined}
                    active={passwordIdentity?.usable ?? false}
                    warning={currentUser.account.passwordStatus === 'reset_required'}
                    action={passwordIdentity ? (
                      <OverflowMenu iconDescription="Actions for Local password" size="sm" flipped>
                        <OverflowMenuItem itemText="Change password" onClick={() => { passwordMutation.reset(); passwordForm.reset(); setPasswordModalOpen(true); }} />
                        {mayRemovePassword && <OverflowMenuItem isDelete hasDivider itemText="Remove password method" onClick={() => { removePasswordMutation.reset(); removePasswordForm.reset(); setRemovePasswordModalOpen(true); }} />}
                      </OverflowMenu>
                    ) : undefined}
                  >
                    {passwordIdentity && !passwordIdentity.verifiedAt && (
                      <div className="authentication-method__identity">
                        <div className="authentication-method__identity-summary">
                          <span>Email verification</span>
                          <span>Not verified</span>
                        </div>
                        <div className="button-cluster">
                          <Button kind="tertiary" size="sm" disabled={emailVerificationMutation.isPending} onClick={() => emailVerificationMutation.mutate()}>{emailVerificationMutation.isPending ? 'Sending…' : 'Send code'}</Button>
                          <Button as={Link} kind="ghost" size="sm" to={`/verify-email?email=${encodeURIComponent(passwordIdentity.displayIdentifier ?? '')}`}>Enter code</Button>
                        </div>
                      </div>
                    )}
                  </AuthenticationMethod>

                  <AuthenticationMethod
                    label="Username and PIN"
                    status={!pinIdentity ? 'Not configured' : pinIdentity.disabledAt ? 'Disabled' : pinIdentity.usable ? 'Active' : 'Not configured'}
                    detail={pinIdentity?.displayIdentifier ? `Username: ${pinIdentity.displayIdentifier}` : undefined}
                    active={pinIdentity?.usable ?? false}
                    action={(mayEnrollPIN || (pinIdentity && mayRemovePIN)) ? (
                      <OverflowMenu iconDescription="Actions for Username and PIN" size="sm" flipped>
                        {mayEnrollPIN && <OverflowMenuItem itemText={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'} onClick={() => { pinMutation.reset(); pinForm.reset({ loginName: pinIdentity?.displayIdentifier ?? '', pin: '', confirmPIN: '' }); setPINModalOpen(true); }} />}
                        {pinIdentity && mayRemovePIN && <OverflowMenuItem isDelete hasDivider={mayEnrollPIN} itemText="Remove PIN method" onClick={() => { removePINMutation.reset(); setRemovePINModalOpen(true); }} />}
                      </OverflowMenu>
                    ) : undefined}
                  />

                  <AuthenticationMethod
                    label="OIDC / SSO"
                    status={oidcIdentities.length ? `${oidcIdentities.filter((identity) => identity.usable).length} active` : 'Not connected'}
                    active={oidcIdentities.some((identity) => identity.usable)}
                    action={mayLinkOIDC && oidcProviders.data && oidcProviders.data.items.length > 0 ? (
                      <OverflowMenu iconDescription="Actions for OIDC / SSO" size="sm" flipped>
                        {oidcProviders.data.items.map((provider) => (
                          <OverflowMenuItem key={provider.slug} itemText={`Link ${provider.displayName}`} onClick={() => { oidcLinkForm.reset(); linkOIDCMutation.reset(); setOIDCProviderToLink(provider); }} />
                        ))}
                      </OverflowMenu>
                    ) : undefined}
                  >
                    {oidcIdentities.map((identity) => (
                      <div className="authentication-method__identity" key={identity.id}>
                        <div className="authentication-method__identity-summary">
                          <span>{identity.displayIdentifier ?? 'OIDC provider'}</span>
                          <span>{identity.disabledAt ? 'Disabled' : identity.usable ? 'Active' : 'Provider unavailable'}</span>
                          {identity.providerSlug && <code>{identity.providerSlug}</code>}
                        </div>
                        {(identity.providerSlug && identity.usable) || mayUnlinkOIDC ? (
                          <OverflowMenu iconDescription={`Actions for ${identity.displayIdentifier ?? 'OIDC identity'}`} size="sm" flipped>
                            {identity.providerSlug && identity.usable && <OverflowMenuItem itemText={`Reauthenticate with ${identity.displayIdentifier ?? 'OIDC'}`} onClick={() => reauthenticateOIDCMutation.mutate(identity.providerSlug!)} />}
                            {mayUnlinkOIDC && <OverflowMenuItem isDelete hasDivider={Boolean(identity.providerSlug && identity.usable)} itemText="Unlink identity" onClick={() => unlinkOIDCMutation.mutate(identity.id)} />}
                          </OverflowMenu>
                        ) : null}
                      </div>
                    ))}
                  </AuthenticationMethod>
                </div>
              </DetailSection>

              <DetailSection
                title="Roles"
                meta={<span className="section-description">{currentUser.account.roles.length} assigned</span>}
              >
                <div className="tag-list" aria-label="Assigned roles">
                  {currentUser.account.roles.length === 0 && <span>No roles assigned</span>}
                  {currentUser.account.roles.map((role) => (
                    <Tag key={role.id} type={role.systemKey === 'master' ? 'purple' : 'blue'}>{role.name}</Tag>
                  ))}
                </div>
              </DetailSection>
            </Stack>
          </Column>
        </Grid>
      </div>

      <ComposedModal aria-label="Change password" open={passwordModalOpen} onClose={closePasswordModal}>
        <ModalHeader title="Change password" label={passwordIdentity?.displayIdentifier ?? undefined} />
        <ModalBody>
          <Form id="change-own-password-form" onSubmit={submitPassword}>
            <Stack gap={5}>
              <p>Changing your password signs out your other sessions.</p>
              {passwordMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Password not changed" subtitle="Check your current password and try again." />}
              <PasswordInput id="profile-current-password" autoComplete="current-password" labelText="Current password" invalid={Boolean(passwordForm.formState.errors.currentPassword)} invalidText={passwordForm.formState.errors.currentPassword?.message} {...passwordForm.register('currentPassword', { required: 'Enter your current password.' })} />
              <PasswordInput id="profile-new-password" autoComplete="new-password" labelText="New password" helperText="Use at least 12 characters." invalid={Boolean(passwordForm.formState.errors.newPassword)} invalidText={passwordForm.formState.errors.newPassword?.message} {...passwordForm.register('newPassword', { required: 'Enter a new password.', validate: validatePasswordLength })} />
              <PasswordInput id="profile-confirm-password" autoComplete="new-password" labelText="Confirm new password" invalid={Boolean(passwordForm.formState.errors.confirmPassword)} invalidText={passwordForm.formState.errors.confirmPassword?.message} {...passwordForm.register('confirmPassword', { required: 'Confirm the new password.', validate: (value) => value === passwordForm.watch('newPassword') || 'The passwords do not match.' })} />
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={closePasswordModal}>Cancel</Button>
          <Button type="submit" form="change-own-password-form" disabled={passwordMutation.isPending}>{passwordMutation.isPending ? 'Changing…' : 'Change password'}</Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal aria-label="Remove password method" open={removePasswordModalOpen} danger onClose={closeRemovePasswordModal}>
        <ModalHeader title="Remove password method?" />
        <ModalBody>
          <Form id="remove-own-password-form" onSubmit={submitRemovePassword}>
            <Stack gap={5}>
              <p>You will be signed out. Your account remains active, but you will need another authentication method to sign in again.</p>
              {removePasswordMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Password method not removed" subtitle="Check your current password and try again." />}
              <PasswordInput id="remove-password-current-password" autoComplete="current-password" labelText="Current password" invalid={Boolean(removePasswordForm.formState.errors.currentPassword)} invalidText={removePasswordForm.formState.errors.currentPassword?.message} {...removePasswordForm.register('currentPassword', { required: 'Enter your current password.' })} />
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={closeRemovePasswordModal}>Cancel</Button>
          <Button kind="danger" type="submit" form="remove-own-password-form" disabled={removePasswordMutation.isPending}>Remove password</Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal aria-label={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'} open={pinModalOpen} onClose={closePINModal}>
        <ModalHeader title={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'} />
        <ModalBody>
          <Form id="set-own-pin-form" onSubmit={submitPIN}>
            <Stack gap={5}>
              {pinMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="PIN not changed" subtitle="The username may be unavailable or the session may not be fresh enough." />}
              <TextInput id="profile-pin-login-name" labelText="Username" autoComplete="username" invalid={Boolean(pinForm.formState.errors.loginName)} invalidText={pinForm.formState.errors.loginName?.message} {...pinForm.register('loginName', { required: 'Enter a username.', pattern: { value: /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/, message: 'Use 3 to 64 supported characters and start with a letter or number.' } })} />
              <PasswordInput id="profile-pin" labelText="PIN" autoComplete="new-password" helperText="Use 6 to 12 digits." invalid={Boolean(pinForm.formState.errors.pin)} invalidText={pinForm.formState.errors.pin?.message} {...pinForm.register('pin', { required: 'Enter a PIN.', pattern: { value: /^[0-9]{6,12}$/, message: 'Use 6 to 12 digits.' } })} />
              <PasswordInput id="profile-pin-confirm" labelText="Confirm PIN" autoComplete="new-password" invalid={Boolean(pinForm.formState.errors.confirmPIN)} invalidText={pinForm.formState.errors.confirmPIN?.message} {...pinForm.register('confirmPIN', { required: 'Confirm the PIN.', validate: (value) => value === pinForm.watch('pin') || 'The PINs do not match.' })} />
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={closePINModal}>Cancel</Button>
          <Button type="submit" form="set-own-pin-form" disabled={!freshEnoughForMethods || pinMutation.isPending}>Set PIN login</Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal aria-label="Remove PIN method" open={removePINModalOpen} danger onClose={() => setRemovePINModalOpen(false)}>
        <ModalHeader title="Remove username and PIN?" />
        <ModalBody>
          <Stack gap={5}>
            <p>Your account remains active or inactive independently. You will need another authentication method to sign in.</p>
            {removePINMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="PIN method not removed" subtitle="Reauthenticate and try again." />}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={() => setRemovePINModalOpen(false)}>Cancel</Button>
          <Button kind="danger" disabled={!freshEnoughForMethods || removePINMutation.isPending} onClick={() => removePINMutation.mutate()}>Remove PIN</Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal aria-label={oidcProviderToLink ? `Link ${oidcProviderToLink.displayName}` : 'Link OIDC provider'} open={Boolean(oidcProviderToLink)} onClose={closeOIDCLinkModal}>
        <ModalHeader title={oidcProviderToLink ? `Link ${oidcProviderToLink.displayName}` : 'Link OIDC provider'} />
        <ModalBody>
          <Form id="link-oidc-provider-form" onSubmit={submitOIDCLink}>
            <Stack gap={5}>
              <p>Linking is available for five minutes after recent password or OIDC authentication.</p>
              {passwordIdentity && <PasswordInput id="oidc-link-password" labelText="Current local password (optional)" helperText="Leave blank after recent authentication." autoComplete="current-password" {...oidcLinkForm.register('currentPassword')} />}
              {linkOIDCMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="External identity not linked" subtitle={linkOIDCMutation.error?.message ?? 'Reauthenticate and try again.'} />}
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={closeOIDCLinkModal}>Cancel</Button>
          <Button type="submit" form="link-oidc-provider-form" disabled={linkOIDCMutation.isPending}>Link provider</Button>
        </ModalFooter>
      </ComposedModal>
    </PageShell>
  );
}

function formatProvisioningSource(source: string): string {
  return source.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}
