import {
  Button,
  ComposedModal,
  Form,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  PasswordInput,
  Stack,
  TextInput,
} from '@carbon/react';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { validatePasswordLength } from '../auth/password-validation';
import type { ProfileAuthentication } from './useProfileAuthentication';

export function AuthenticationDialogs({ authentication }: { authentication: ProfileAuthentication }) {
  const {
    passwordModalOpen,
    removePasswordModalOpen,
    pinModalOpen,
    removePINModalOpen,
    setRemovePINModalOpen,
    oidcUnlinkLauncher,
    oidcIdentityToUnlink,
    setOIDCIdentityToUnlink,
    oidcProviderToLink,
    passwordForm,
    removePasswordForm,
    pinForm,
    oidcLinkForm,
    passwordMutation,
    removePasswordMutation,
    pinMutation,
    removePINMutation,
    linkOIDCMutation,
    unlinkOIDCMutation,
    pinIdentity,
    passwordIdentity,
    freshEnoughForMethods,
    submitPassword,
    submitPIN,
    submitRemovePassword,
    submitOIDCLink,
    closePasswordModal,
    closeRemovePasswordModal,
    closePINModal,
    closeOIDCLinkModal,
    requestCloseRemovePassword,
    requestCloseRemovePIN,
  } = authentication;

  return (
    <>
      <ComposedModal aria-label="Change password" open={passwordModalOpen} onClose={closePasswordModal}>
        <ModalHeader title="Change password" label={passwordIdentity?.displayIdentifier ?? undefined} />
        <ModalBody>
          <Form id="change-own-password-form" onSubmit={submitPassword}>
            <Stack gap={5}>
              <p>Changing your password signs out your other sessions.</p>
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
                invalidText={passwordForm.formState.errors.currentPassword?.message}
                {...passwordForm.register('currentPassword', { required: 'Enter your current password.' })}
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
                invalidText={passwordForm.formState.errors.confirmPassword?.message}
                {...passwordForm.register('confirmPassword', {
                  required: 'Confirm the new password.',
                  validate: (value) => value === passwordForm.watch('newPassword') || 'The passwords do not match.',
                })}
              />
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={closePasswordModal}>
            Cancel
          </Button>
          <Button type="submit" form="change-own-password-form" disabled={passwordMutation.isPending}>
            {passwordMutation.isPending ? 'Changing…' : 'Change password'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal
        aria-label="Remove password method"
        open={removePasswordModalOpen}
        danger
        selectorPrimaryFocus=".cds--btn--secondary"
        preventCloseOnClickOutside
        onClose={requestCloseRemovePassword}
      >
        <ModalHeader title="Remove password method?" />
        <ModalBody>
          <Form id="remove-own-password-form" onSubmit={submitRemovePassword}>
            <Stack gap={5}>
              <p>
                You will be signed out. Your account remains active, but you will need another authentication method to
                sign in again.
              </p>
              {removePasswordMutation.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Password method not removed"
                  subtitle="Check your current password and try again."
                />
              )}
              <PasswordInput
                id="remove-password-current-password"
                autoComplete="current-password"
                labelText="Current password"
                invalid={Boolean(removePasswordForm.formState.errors.currentPassword)}
                invalidText={removePasswordForm.formState.errors.currentPassword?.message}
                {...removePasswordForm.register('currentPassword', { required: 'Enter your current password.' })}
              />
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={removePasswordMutation.isPending} onClick={closeRemovePasswordModal}>
            Cancel
          </Button>
          <Button
            kind="danger"
            type="submit"
            form="remove-own-password-form"
            disabled={removePasswordMutation.isPending}
          >
            {removePasswordMutation.isPending ? 'Removing…' : 'Remove password'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal
        aria-label={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'}
        open={pinModalOpen}
        onClose={closePINModal}
      >
        <ModalHeader title={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'} />
        <ModalBody>
          <Form id="set-own-pin-form" onSubmit={submitPIN}>
            <Stack gap={5}>
              {pinMutation.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="PIN not changed"
                  subtitle="The username may be unavailable or the session may not be fresh enough."
                />
              )}
              <TextInput
                id="profile-pin-login-name"
                labelText="Username"
                autoComplete="username"
                invalid={Boolean(pinForm.formState.errors.loginName)}
                invalidText={pinForm.formState.errors.loginName?.message}
                {...pinForm.register('loginName', {
                  required: 'Enter a username.',
                  pattern: {
                    value: /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/,
                    message: 'Use 3 to 64 supported characters and start with a letter or number.',
                  },
                })}
              />
              <PasswordInput
                id="profile-pin"
                labelText="PIN"
                autoComplete="new-password"
                helperText="Use 6 to 12 digits."
                invalid={Boolean(pinForm.formState.errors.pin)}
                invalidText={pinForm.formState.errors.pin?.message}
                {...pinForm.register('pin', {
                  required: 'Enter a PIN.',
                  pattern: { value: /^[0-9]{6,12}$/, message: 'Use 6 to 12 digits.' },
                })}
              />
              <PasswordInput
                id="profile-pin-confirm"
                labelText="Confirm PIN"
                autoComplete="new-password"
                invalid={Boolean(pinForm.formState.errors.confirmPIN)}
                invalidText={pinForm.formState.errors.confirmPIN?.message}
                {...pinForm.register('confirmPIN', {
                  required: 'Confirm the PIN.',
                  validate: (value) => value === pinForm.watch('pin') || 'The PINs do not match.',
                })}
              />
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={closePINModal}>
            Cancel
          </Button>
          <Button type="submit" form="set-own-pin-form" disabled={!freshEnoughForMethods || pinMutation.isPending}>
            Set PIN login
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal
        aria-label="Remove PIN method"
        open={removePINModalOpen}
        danger
        selectorPrimaryFocus=".cds--btn--secondary"
        preventCloseOnClickOutside
        onClose={requestCloseRemovePIN}
      >
        <ModalHeader title="Remove username and PIN?" />
        <ModalBody>
          <Stack gap={5}>
            <p>
              Your account remains active or inactive independently. You will need another authentication method to sign
              in.
            </p>
            {removePINMutation.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="PIN method not removed"
                subtitle="Reauthenticate and try again."
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" disabled={removePINMutation.isPending} onClick={() => setRemovePINModalOpen(false)}>
            Cancel
          </Button>
          <Button
            kind="danger"
            disabled={!freshEnoughForMethods || removePINMutation.isPending}
            onClick={() => removePINMutation.mutate()}
          >
            {removePINMutation.isPending ? 'Removing…' : 'Remove PIN'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <DestructiveActionDialog
        open={Boolean(oidcIdentityToUnlink)}
        title="Unlink external identity?"
        launcherButtonRef={oidcUnlinkLauncher}
        confirmLabel="Unlink identity"
        pending={unlinkOIDCMutation.isPending}
        error={unlinkOIDCMutation.isError ? 'Try again after reauthenticating.' : undefined}
        onClose={() => {
          setOIDCIdentityToUnlink(null);
          unlinkOIDCMutation.reset();
        }}
        onConfirm={() => oidcIdentityToUnlink && unlinkOIDCMutation.mutate(oidcIdentityToUnlink.id)}
      >
        <p>
          {oidcIdentityToUnlink?.displayIdentifier ?? 'This external identity'} will no longer be usable to sign in.
          Your account and other authentication methods remain unchanged.
        </p>
      </DestructiveActionDialog>

      <ComposedModal
        aria-label={oidcProviderToLink ? `Link ${oidcProviderToLink.displayName}` : 'Link OIDC provider'}
        open={Boolean(oidcProviderToLink)}
        onClose={closeOIDCLinkModal}
      >
        <ModalHeader title={oidcProviderToLink ? `Link ${oidcProviderToLink.displayName}` : 'Link OIDC provider'} />
        <ModalBody>
          <Form id="link-oidc-provider-form" onSubmit={submitOIDCLink}>
            <Stack gap={5}>
              <p>Linking is available for five minutes after recent password or OIDC authentication.</p>
              {passwordIdentity && (
                <PasswordInput
                  id="oidc-link-password"
                  labelText="Current local password (optional)"
                  helperText="Leave blank after recent authentication."
                  autoComplete="current-password"
                  {...oidcLinkForm.register('currentPassword')}
                />
              )}
              {linkOIDCMutation.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="External identity not linked"
                  subtitle={linkOIDCMutation.error?.message ?? 'Reauthenticate and try again.'}
                />
              )}
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={closeOIDCLinkModal}>
            Cancel
          </Button>
          <Button type="submit" form="link-oidc-provider-form" disabled={linkOIDCMutation.isPending}>
            Link provider
          </Button>
        </ModalFooter>
      </ComposedModal>
    </>
  );
}
