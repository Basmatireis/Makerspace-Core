import { useState } from 'react';
import {
  Button,
  Column,
  Form,
  Grid,
  InlineNotification,
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
import { Edit } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../app/PageHeader';
import { changeOwnPassword, enrollOwnPin, removeOwnPassword, removeOwnPin, requestOwnEmailVerification } from '../../api/generated/authentication/authentication';
import { updatePerson } from '../../api/generated/people/people';
import { deletePersonProfileImage, getPutPersonProfileImageUrl } from '../../api/generated/people/people';
import type { ProfileImage, UpdatePersonRequest } from '../../api/generated/models';
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
import { ProfilePictureEditor } from '../users/ProfilePictureEditor';

type PasswordFormValues = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};
type PINFormValues = { loginName: string; pin: string; confirmPIN: string };
type OIDCLinkFormValues = { currentPassword: string };

export function ProfilePage() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const [editingProfile, setEditingProfile] = useState(false);
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
    { onSuccess: () => passwordForm.reset() },
  );
  const removePasswordMutation = useSecretMutation(
    (currentPassword: string) => removeOwnPassword({ currentPassword }),
    { onSuccess: () => window.location.assign('/login') },
  );
  const pinMutation = useSecretMutation(
    ({ loginName, pin }: PINFormValues) => enrollOwnPin({ loginName, pin }),
    { onSuccess: async () => { pinForm.reset(); await queryClient.invalidateQueries({ queryKey: authQueryKey }); } },
  );
  const removePINMutation = useMutation({
    mutationFn: () => removeOwnPin(),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: authQueryKey }),
  });
	const emailVerificationMutation = useMutation({ mutationFn: () => requestOwnEmailVerification() });
  const linkOIDCMutation = useSecretMutation(
    ({ slug, currentPassword }: { slug: string; currentPassword: string }) => startOIDCLink(slug, currentPassword ? { currentPassword } : {}),
    { onSuccess: (flow) => window.location.assign(flow.authorizationUrl) },
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
  const pinIdentity = currentUser.account.authIdentities.find((identity) => identity.kind === 'pin' && !identity.disabledAt);
	const passwordIdentity = currentUser.account.authIdentities.find((identity) => identity.kind === 'password' && !identity.disabledAt);
  const oidcIdentities = currentUser.account.authIdentities.filter((identity) => identity.kind === 'oidc' && !identity.disabledAt);
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

  return (
    <Stack gap={7} className="person-detail-page">
      <PageHeader
        title="Profile"
        description="Review your personal information and account security."
        actions={
          mayEdit && !editingProfile ? (
            <Button renderIcon={Edit} onClick={() => setEditingProfile(true)}>
              Edit profile
            </Button>
          ) : undefined
        }
      />

      <div className="person-detail-layout">
      <Grid condensed className="person-detail-grid">
        <Column sm={4} md={3} lg={4}>
          <Stack gap={6}>
			<Tile className="person-detail-card person-profile-card">
				<Stack gap={5}>
					<h2>Profile picture</h2>
					<ProfilePictureEditor
						id="own-profile-image"
						firstName={currentUser.person.firstName}
						lastName={currentUser.person.lastName}
						profileImage={currentUser.person.profileImage}
						canUpdate={mayUpdateProfileImage}
						canRemove={mayRemoveProfileImage}
						isUploading={profileImageMutation.isPending}
						isRemoving={removeProfileImageMutation.isPending}
						onUpload={(file) => profileImageMutation.mutate(file)}
						onRemove={() => removeProfileImageMutation.mutate()}
					/>
					<p className="person-profile-card__name">{currentUser.person.firstName} {currentUser.person.lastName}</p>
					{currentUser.person.profileImageRequired && !currentUser.person.profileImage && <InlineNotification kind="warning" lowContrast hideCloseButton title="Profile picture required" subtitle="At least one assigned role requires a profile picture." />}
					{profileImageMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Picture not updated" subtitle="Use a JPEG, PNG, or WebP image up to 8 MiB and 4096×4096 pixels." />}
				</Stack>
			</Tile>
			<Tile className="person-detail-card">
            <Stack gap={6}>
              <h2>Personal information</h2>
              {updateProfileMutation.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Profile not updated"
                  subtitle="Review the information and try again."
                />
              )}
              {editingProfile ? (
                <Form onSubmit={submitProfile}>
                  <Stack gap={6}>
                    <PersonFields
                      form={personForm}
                      showMatriculation={mayReadMatriculation}
                      editMatriculation={mayEditMatriculation}
                    />
                  <div className="form-actions">
                    <Button
                        type="button"
                        kind="secondary"
                        onClick={() => {
                          personForm.reset();
                          setEditingProfile(false);
                        }}
                    >
                        Cancel
                      </Button>
                      <Button
                        type="submit"
                        disabled={
                          !personForm.formState.isDirty ||
                          updateProfileMutation.isPending
                        }
                      >
                        {updateProfileMutation.isPending ? 'Saving…' : 'Save'}
                    </Button>
                  </div>
                  </Stack>
                </Form>
              ) : (
                <StructuredListWrapper isCondensed>
                  <StructuredListBody>
                    <StructuredListRow>
                      <StructuredListCell>Name</StructuredListCell>
                      <StructuredListCell>
                        {currentUser.person.firstName} {currentUser.person.lastName}
                      </StructuredListCell>
                    </StructuredListRow>
                    <StructuredListRow>
                      <StructuredListCell>Contact email</StructuredListCell>
                      <StructuredListCell>
                        {currentUser.person.email ?? 'Not provided'}
                      </StructuredListCell>
                    </StructuredListRow>
                    <StructuredListRow>
                      <StructuredListCell>Phone</StructuredListCell>
                      <StructuredListCell>
                        {currentUser.person.phone ?? 'Not provided'}
                      </StructuredListCell>
                    </StructuredListRow>
                    {mayReadMatriculation && (
                      <StructuredListRow>
                        <StructuredListCell>Matriculation number</StructuredListCell>
                        <StructuredListCell>
                          {currentUser.person.matriculationNumber ?? 'Not provided'}
                        </StructuredListCell>
                      </StructuredListRow>
                    )}
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
                <div className="section-heading">
                  <h2>Account access</h2>
                  <Tag
                    type={
                      currentUser.account.status === 'enabled' ? 'green' : 'gray'
                    }
                  >
                    {currentUser.account.status === 'enabled' ? 'Enabled' : 'Disabled'}
                  </Tag>
                </div>
                <StructuredListWrapper isCondensed>
                  <StructuredListBody>
                    <StructuredListRow>
                      <StructuredListCell>Login email</StructuredListCell>
                      <StructuredListCell>{currentUser.account.loginEmail ?? 'Not configured'}</StructuredListCell>
                    </StructuredListRow>
                    <StructuredListRow>
                      <StructuredListCell>Account ID</StructuredListCell>
                      <StructuredListCell><code>{currentUser.account.id}</code></StructuredListCell>
                    </StructuredListRow>
                  </StructuredListBody>
                </StructuredListWrapper>
              </Stack>
            </Tile>

            <Tile className="person-detail-card">
              <Stack gap={6}>
                <div>
                  <h2>Authentication methods</h2>
				  <Stack gap={3}>
					<div className="account-summary"><span>Local password</span><Tag type={currentUser.account.passwordStatus === 'active' ? (passwordIdentity?.verifiedAt ? 'green' : 'warm-gray') : 'gray'}>{currentUser.account.passwordStatus === 'active' ? `Enabled — ${passwordIdentity?.verifiedAt ? 'email verified' : 'email verification required'}` : 'Not configured'}</Tag></div>
					<div className="account-summary"><span>PIN</span><Tag type={pinIdentity ? 'green' : 'gray'}>{pinIdentity ? `Enabled — username: ${pinIdentity.displayIdentifier ?? 'configured'}` : 'Not configured'}</Tag></div>
					<div className="account-summary"><span>OIDC / authentication provider</span><Tag type={oidcIdentities.length > 0 ? 'green' : 'gray'}>{oidcIdentities.length > 0 ? `Connected (${oidcIdentities.length})` : 'Not connected'}</Tag></div>
				  </Stack>
                </div>
				{passwordIdentity && !passwordIdentity.verifiedAt && <Stack gap={3}>
					{emailVerificationMutation.isSuccess && <InlineNotification kind="success" lowContrast hideCloseButton title="Verification code sent" subtitle="Check your login email and enter the code on the verification page." />}
					{emailVerificationMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Verification email not sent" subtitle="Email delivery may be unavailable. Try again later." />}
					<div className="button-cluster">
						<Button kind="tertiary" size="sm" disabled={emailVerificationMutation.isPending} onClick={() => emailVerificationMutation.mutate()}>{emailVerificationMutation.isPending ? 'Sending…' : 'Send verification code'}</Button>
						<Button as={Link} kind="ghost" size="sm" to={`/verify-email?email=${encodeURIComponent(passwordIdentity.displayIdentifier ?? '')}`}>Enter verification code</Button>
					</div>
				</Stack>}
                {!freshEnoughForMethods && <InlineNotification kind="info" lowContrast hideCloseButton title="Recent authentication required" subtitle="Use a password or an already linked OIDC provider before changing authentication methods. PIN alone is insufficient." />}
                {pinMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="PIN not changed" subtitle="The login name may be unavailable or the session is not fresh enough." />}
                {pinMutation.isSuccess && <InlineNotification kind="success" lowContrast hideCloseButton title="PIN method updated" subtitle="Other sessions were signed out." />}
                {mayEnrollPIN && (
                  <Form onSubmit={submitPIN}>
                    <Stack gap={5}>
                      <TextInput id="profile-pin-login-name" labelText="PIN login name" autoComplete="username" invalid={Boolean(pinForm.formState.errors.loginName)} invalidText={pinForm.formState.errors.loginName?.message} {...pinForm.register('loginName', { required: 'Enter a login name.' })} />
                      <PasswordInput id="profile-pin" labelText="PIN" autoComplete="new-password" helperText="Use 6 to 12 digits." invalid={Boolean(pinForm.formState.errors.pin)} invalidText={pinForm.formState.errors.pin?.message} {...pinForm.register('pin', { required: 'Enter a PIN.', pattern: { value: /^[0-9]{6,12}$/, message: 'Use 6 to 12 digits.' } })} />
                      <PasswordInput id="profile-pin-confirm" labelText="Confirm PIN" autoComplete="new-password" invalid={Boolean(pinForm.formState.errors.confirmPIN)} invalidText={pinForm.formState.errors.confirmPIN?.message} {...pinForm.register('confirmPIN', { required: 'Confirm the PIN.', validate: (value) => value === pinForm.watch('pin') || 'The PINs do not match.' })} />
                      <div className="form-actions">
                        <Button type="submit" disabled={!freshEnoughForMethods || pinMutation.isPending}>{pinIdentity ? 'Replace PIN' : 'Enroll PIN'}</Button>
                        {pinIdentity && mayRemovePIN && <Button type="button" kind="danger--tertiary" disabled={!freshEnoughForMethods || removePINMutation.isPending} onClick={() => removePINMutation.mutate()}>Remove PIN</Button>}
                      </div>
                    </Stack>
                  </Form>
                )}
                {reauthenticateOIDCMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Reauthentication failed" subtitle="Use an enabled provider already linked to your account." />}
                {oidcIdentities.map((identity) => (
                  <div className="account-summary" key={identity.id}>
                    <div><span className="label">External identity</span><span>{identity.displayIdentifier ?? 'OIDC provider'}</span></div>
                    {identity.providerSlug && <Button type="button" kind="tertiary" size="sm" disabled={reauthenticateOIDCMutation.isPending} onClick={() => reauthenticateOIDCMutation.mutate(identity.providerSlug!)}>Reauthenticate with {identity.displayIdentifier ?? 'OIDC'}</Button>}
                    {mayUnlinkOIDC && <Button type="button" kind="danger--tertiary" size="sm" disabled={unlinkOIDCMutation.isPending} onClick={() => unlinkOIDCMutation.mutate(identity.id)}>Unlink</Button>}
                  </div>
                ))}
                {mayLinkOIDC && oidcProviders.data && oidcProviders.data.items.length > 0 && (
                  <Form onSubmit={(event) => event.preventDefault()}>
                    <Stack gap={4}>
                      {passwordIdentity && <PasswordInput id="oidc-link-password" labelText="Current local password (optional)" helperText="Leave blank after recent password or OIDC authentication. Linking is available for five minutes." autoComplete="current-password" {...oidcLinkForm.register('currentPassword')} />}
                      <div className="button-cluster">
                        {oidcProviders.data.items.map((provider) => <Button key={provider.slug} type="button" kind="tertiary" disabled={linkOIDCMutation.isPending} onClick={oidcLinkForm.handleSubmit(({ currentPassword }) => void linkOIDCMutation.mutateAsync({ slug: provider.slug, currentPassword }).catch(() => {}))}>Link {provider.displayName}</Button>)}
                      </div>
                      {linkOIDCMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="External identity not linked" subtitle={linkOIDCMutation.error?.message ?? "Reauthenticate with a password or linked OIDC provider and try again."} />}
                      {unlinkOIDCMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="External identity not removed" subtitle="An enabled account must retain at least one usable sign-in method." />}
                    </Stack>
                  </Form>
                )}
              </Stack>
            </Tile>

            <Tile className="person-detail-card">
              <Stack gap={5}>
                <div className="section-heading">
                  <h2>Roles</h2>
                  <span className="section-description">{currentUser.account.roles.length} assigned</span>
                </div>
                <div className="tag-list" aria-label="Assigned roles">
                  {currentUser.account.roles.length === 0 && <span>No roles assigned</span>}
                  {currentUser.account.roles.map((role) => (
                    <Tag key={role.id} type={role.systemKey === 'master' ? 'purple' : 'blue'}>
                      {role.name}
                    </Tag>
                  ))}
                </div>
              </Stack>
            </Tile>

            <Tile className="person-detail-card">
              <Form onSubmit={submitPassword}>
                <Stack gap={6}>
                  <div>
                    <h2>Change password</h2>
                    <p className="section-description">
                      Changing your password signs out your other sessions.
                    </p>
                  </div>
                  {passwordMutation.isSuccess && (
                    <InlineNotification
                      kind="success"
                      lowContrast
                      hideCloseButton
                      title="Password changed"
                      subtitle="Your other sessions have been signed out."
                    />
                  )}
                  {passwordMutation.isError && (
                    <InlineNotification
                      kind="error"
                      lowContrast
                      hideCloseButton
                      title="Password not changed"
                      subtitle="Check your current password and try again."
                    />
                  )}
                  <PasswordInput
                    id="profile-current-password"
                    autoComplete="current-password"
                    labelText="Current password"
                    invalid={Boolean(passwordForm.formState.errors.currentPassword)}
                    invalidText={
                      passwordForm.formState.errors.currentPassword?.message
                    }
                    {...passwordForm.register('currentPassword', {
                      required: 'Enter your current password.',
                    })}
                  />
                  <PasswordInput
                    id="profile-new-password"
                    autoComplete="new-password"
                    labelText="New password"
                    helperText="Use at least 12 characters."
                    invalid={Boolean(passwordForm.formState.errors.newPassword)}
                    invalidText={passwordForm.formState.errors.newPassword?.message}
                    {...passwordForm.register('newPassword', {
                      required: 'Enter a new password.',
                      validate: validatePasswordLength,
                    })}
                  />
                  <PasswordInput
                    id="profile-confirm-password"
                    autoComplete="new-password"
                    labelText="Confirm new password"
                    invalid={Boolean(passwordForm.formState.errors.confirmPassword)}
                    invalidText={
                      passwordForm.formState.errors.confirmPassword?.message
                    }
                    {...passwordForm.register('confirmPassword', {
                      required: 'Confirm the new password.',
                      validate: (value) =>
                        value === passwordForm.watch('newPassword') ||
                        'The passwords do not match.',
                    })}
                  />
                  <Button type="submit" disabled={passwordMutation.isPending}>
                    {passwordMutation.isPending ? 'Changing…' : 'Change password'}
                  </Button>
                  {mayRemovePassword && currentUser.account.authIdentities.filter((identity) => !identity.disabledAt).length > 1 && (
                    <Button type="button" kind="danger--tertiary" disabled={removePasswordMutation.isPending} onClick={async () => { if (await passwordForm.trigger('currentPassword')) void removePasswordMutation.mutateAsync(passwordForm.getValues('currentPassword')); }}>Remove password</Button>
                  )}
                </Stack>
              </Form>
            </Tile>
          </Stack>
        </Column>
      </Grid>
      </div>
    </Stack>
  );
}
