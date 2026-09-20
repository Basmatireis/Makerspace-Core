import { useState } from 'react';
import { Button, Form, InlineNotification, Link as CarbonLink, PasswordInput, Stack, TextInput } from '@carbon/react';
import { ArrowLeft, Checkmark } from '@carbon/icons-react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { completeEmailVerification, completeInvitation, completePasswordResetCode, completePinEnrollment, requestPasswordReset } from '../../api/generated/authentication/authentication';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { validatePasswordLength } from './password-validation';

type FormValues = { email: string; code: string; newPassword: string; confirmPassword: string };
type PINSetupValues = { code: string; loginName: string; pin: string; confirmPIN: string };
type EmailVerificationValues = { email: string; code: string };

function useChallengeParameters() {
  const [query] = useSearchParams();
  const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  return {
    get(name: string) {
      return fragment.get(name) ?? query.get(name);
    },
  };
}

export function ResetPasswordPage() {
  return <PasswordChallengePage invitation={false} />;
}

export function InvitationPage() {
  return <PasswordChallengePage invitation />;
}

export function PINEnrollmentPage() {
	const params = useChallengeParameters();
	const accountId = params.get('account') ?? '';
	const mutation = useSecretMutation((values: Omit<PINSetupValues, 'confirmPIN'>) => completePinEnrollment({ accountId, ...values }));
	const form = useForm<PINSetupValues>({ defaultValues: { code: params.get('code') ?? '', loginName: '', pin: '', confirmPIN: '' } });
	const submit = form.handleSubmit(async ({ code, loginName, pin }) => {
		try { await mutation.mutateAsync({ code: code.toUpperCase(), loginName, pin }); } catch { /* safe error below */ }
	});
	return <main className="auth-page"><section className="auth-card" aria-labelledby="pin-setup-title"><Stack gap={7}>
		<div><p className="auth-card__eyebrow">HTU Graz Makerspace</p><h1 id="pin-setup-title" className="auth-card__title">Set up PIN login</h1><p className="auth-card__subtitle">Choose a unique username and a 6–12 digit PIN. The setup code is single-use.</p></div>
		{!accountId && <InlineNotification kind="error" lowContrast hideCloseButton title="Invalid setup link" subtitle="Use the link from your PIN setup email." />}
		{mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="PIN login not configured" subtitle="The code may be invalid or expired, or the username may be unavailable." />}
		{mutation.isSuccess ? <Stack gap={6}><InlineNotification kind="success" lowContrast hideCloseButton title="PIN login ready" subtitle="You can now sign in with your username and PIN." /><Button as={Link} to="/login" renderIcon={Checkmark}>Continue to sign in</Button></Stack> : <Form onSubmit={submit}><Stack gap={6}>
			<TextInput id="pin-setup-code" autoComplete="one-time-code" labelText="Setup code" maxLength={8} invalid={Boolean(form.formState.errors.code)} invalidText={form.formState.errors.code?.message} {...form.register('code', { required: 'Enter the eight-character setup code.', pattern: { value: /^[23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{8}$/, message: 'Enter the eight-character setup code.' } })} />
			<TextInput id="pin-setup-login-name" autoComplete="username" labelText="Username" helperText="Use 3–64 letters, digits, dots, underscores, or hyphens." invalid={Boolean(form.formState.errors.loginName)} invalidText={form.formState.errors.loginName?.message} {...form.register('loginName', { required: 'Choose a username.', pattern: { value: /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/, message: 'Choose a valid 3–64 character username.' } })} />
			<PasswordInput id="pin-setup-pin" autoComplete="new-password" labelText="PIN" invalid={Boolean(form.formState.errors.pin)} invalidText={form.formState.errors.pin?.message} {...form.register('pin', { required: 'Choose a PIN.', pattern: { value: /^[0-9]{6,12}$/, message: 'Use 6 to 12 digits.' } })} />
			<PasswordInput id="pin-setup-confirm" autoComplete="new-password" labelText="Confirm PIN" invalid={Boolean(form.formState.errors.confirmPIN)} invalidText={form.formState.errors.confirmPIN?.message} {...form.register('confirmPIN', { required: 'Confirm the PIN.', validate: (value) => value === form.watch('pin') || 'The PINs do not match.' })} />
			<Button type="submit" disabled={!accountId || mutation.isPending}>{mutation.isPending ? 'Configuring…' : 'Configure PIN login'}</Button>
		</Stack></Form>}
		<CarbonLink as={Link} to="/login" renderIcon={ArrowLeft}>Back to sign in</CarbonLink>
	</Stack></section></main>;
}

export function EmailVerificationPage() {
	const [params] = useSearchParams();
	const form = useForm<EmailVerificationValues>({ defaultValues: { email: params.get('email') ?? '', code: '' } });
	const mutation = useSecretMutation((values: EmailVerificationValues) => completeEmailVerification({ ...values, code: values.code.toUpperCase() }));
	const submit = form.handleSubmit(async (values) => {
		try { await mutation.mutateAsync(values); } catch { /* safe error below */ }
	});
	return <main className="auth-page"><section className="auth-card" aria-labelledby="email-verification-title"><Stack gap={7}>
		<div><p className="auth-card__eyebrow">HTU Graz Makerspace</p><h1 id="email-verification-title" className="auth-card__title">Verify your login email</h1><p className="auth-card__subtitle">Enter the single-use code sent to your local login email.</p></div>
		{mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Email not verified" subtitle="The code is invalid, expired, or has too many failed attempts." />}
		{mutation.isSuccess ? <Stack gap={6}><InlineNotification kind="success" lowContrast hideCloseButton title="Email verified" subtitle="Your local login email is now verified." /><Button as={Link} to="/profile" renderIcon={Checkmark}>Return to profile</Button></Stack> : <Form onSubmit={submit}><Stack gap={6}>
			<TextInput id="verification-email" type="email" autoComplete="email" labelText="Login email" invalid={Boolean(form.formState.errors.email)} invalidText={form.formState.errors.email?.message} {...form.register('email', { required: 'Enter your login email.' })} />
			<TextInput id="verification-code" autoComplete="one-time-code" labelText="Verification code" maxLength={8} invalid={Boolean(form.formState.errors.code)} invalidText={form.formState.errors.code?.message} {...form.register('code', { required: 'Enter the eight-character verification code.', pattern: { value: /^[23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{8}$/, message: 'Enter the eight-character verification code.' } })} />
			<Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Verifying…' : 'Verify email'}</Button>
		</Stack></Form>}
		<CarbonLink as={Link} to="/login" renderIcon={ArrowLeft}>Back to sign in</CarbonLink>
	</Stack></section></main>;
}

function PasswordChallengePage({ invitation }: { invitation: boolean }) {
  const params = useChallengeParameters();
  const linkedCode = params.get('code') ?? '';
  const [requestAccepted, setRequestAccepted] = useState(invitation || Boolean(linkedCode));
  const requestMutation = useSecretMutation((email: string) => requestPasswordReset({ email }));
  const completeMutation = useSecretMutation((values: Pick<FormValues, 'email' | 'code' | 'newPassword'>) =>
    invitation ? completeInvitation(values) : completePasswordResetCode(values));
  const { register, handleSubmit, getValues, watch, formState: { errors }, reset } = useForm<FormValues>({
    defaultValues: { email: params.get('email') ?? '', code: linkedCode, newPassword: '', confirmPassword: '' },
  });

  const requestCode = async () => {
    const email = getValues('email');
    if (!email) return;
    try {
      await requestMutation.mutateAsync(email);
      setRequestAccepted(true);
    } catch { /* generic error below */ }
  };
  const complete = handleSubmit(async ({ email, code, newPassword }) => {
    try {
      await completeMutation.mutateAsync({ email, code: code.toUpperCase(), newPassword });
      reset();
    } catch { /* generic error below */ }
  });

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="reset-title">
        <Stack gap={7}>
          <div>
            <p className="auth-card__eyebrow">HTU Graz Makerspace</p>
            <h1 id="reset-title" className="auth-card__title">{invitation ? 'Complete your invitation' : 'Reset your password'}</h1>
            <p className="auth-card__subtitle">Codes are single-use, expire after a short time, and allow five attempts.</p>
          </div>

          {requestAccepted && !completeMutation.isSuccess && (
            <InlineNotification kind="info" lowContrast hideCloseButton title={invitation ? 'Enter your invitation code' : 'Request accepted'} subtitle={invitation ? 'Use the code from your invitation email.' : 'If this account can recover by email, a code has been sent.'} />
          )}
          {requestMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Request unavailable" subtitle="Try again later." />}
          {completeMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Unable to continue" subtitle="The code is invalid, expired, or has too many failed attempts." />}

          {completeMutation.isSuccess ? (
            <Stack gap={6}>
              <InlineNotification kind="success" lowContrast hideCloseButton title={invitation ? 'Account ready' : 'Password updated'} subtitle="You can now sign in with your password." />
              <Button as={Link} to="/login" renderIcon={Checkmark}>Continue to sign in</Button>
            </Stack>
          ) : (
            <Form onSubmit={complete}>
              <Stack gap={6}>
                <TextInput id="challenge-email" type="email" autoComplete="email" labelText="Login email" invalid={Boolean(errors.email)} invalidText={errors.email?.message} {...register('email', { required: 'Enter your login email.' })} />
                {!invitation && !requestAccepted && <Button type="button" kind="secondary" disabled={requestMutation.isPending} onClick={() => void requestCode()}>{requestMutation.isPending ? 'Requesting…' : 'Send reset code'}</Button>}
                {requestAccepted && (
                  <>
                    <TextInput id="challenge-code" autoComplete="one-time-code" labelText={invitation ? 'Invitation code' : 'Reset code'} maxLength={8} invalid={Boolean(errors.code)} invalidText={errors.code?.message} {...register('code', { required: 'Enter the eight-character code.', pattern: { value: /^[23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz]{8}$/, message: 'Enter the eight-character code.' } })} />
                    <PasswordInput id="reset-new-password" autoComplete="new-password" labelText="New password" helperText="Use at least 12 characters." invalid={Boolean(errors.newPassword)} invalidText={errors.newPassword?.message} {...register('newPassword', { required: 'Enter a new password.', validate: validatePasswordLength })} />
                    <PasswordInput id="reset-confirm-password" autoComplete="new-password" labelText="Confirm new password" invalid={Boolean(errors.confirmPassword)} invalidText={errors.confirmPassword?.message} {...register('confirmPassword', { required: 'Confirm the new password.', validate: (value) => value === watch('newPassword') || 'The passwords do not match.' })} />
                    <Button type="submit" disabled={completeMutation.isPending}>{completeMutation.isPending ? 'Updating…' : invitation ? 'Complete invitation' : 'Update password'}</Button>
                  </>
                )}
              </Stack>
            </Form>
          )}
          <CarbonLink as={Link} to="/login" renderIcon={ArrowLeft}>Back to sign in</CarbonLink>
        </Stack>
      </section>
    </main>
  );
}
