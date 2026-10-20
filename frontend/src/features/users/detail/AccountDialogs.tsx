import { Button, ComposedModal, Form, InlineNotification, ModalBody, ModalFooter, ModalHeader, PasswordInput, Stack, TextInput } from '@carbon/react';
import type { AuthIdentitySummary, Person } from '../../../api/generated/models';
import { validatePasswordLength } from '../../auth/password-validation';
import type { PersonDetailActions } from './usePersonDetailActions';

/** Dialogs that create an account or set its login email, PIN login or password. */
export function AccountDialogs({ person, passwordIdentity, pinIdentity, ctrl }: {
  person: Person;
  passwordIdentity: AuthIdentitySummary | undefined;
  pinIdentity: AuthIdentitySummary | undefined;
  ctrl: PersonDetailActions;
}) {
  const {
    createAccountOpen, setCreateAccountOpen, accountCreateForm, submitCreateAccount, createAccountMutation,
    loginEmailModalOpen, setLoginEmailModalOpen, accountEmailForm, submitEmail, emailMutation,
    pinModalOpen, setPINModalOpen, accountPINForm, submitPIN, pinMutation,
    passwordModalOpen, setPasswordModalOpen, accountPasswordForm, submitPassword, passwordMutation,
  } = ctrl;

  return (
    <>
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
    </>
  );
}
