import { useEffect, useState } from 'react';
import {
  Button,
  Form,
  InlineNotification,
  Link as CarbonLink,
  PasswordInput,
  Stack,
} from '@carbon/react';
import { ArrowLeft, Checkmark } from '@carbon/icons-react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import type { CompletePasswordResetRequest } from '../../api/generated/models';
import { completePasswordReset } from '../../api/generated/authentication/authentication';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { validatePasswordLength } from './password-validation';

type ResetForm = {
  newPassword: string;
  confirmPassword: string;
};

function readFragmentToken(): string {
  const fragment = window.location.hash.slice(1);
  const params = new URLSearchParams(fragment);
  return params.get('token') ?? (fragment.includes('=') ? '' : fragment);
}

export function ResetPasswordPage() {
  const [token, setToken] = useState(readFragmentToken);
  const resetMutation = useSecretMutation(
    (request: CompletePasswordResetRequest) => completePasswordReset(request),
  );
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
    reset,
    setFocus,
  } = useForm<ResetForm>({
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  useEffect(() => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}`,
    );
  }, []);

  useEffect(() => {
    if (token) {
      setFocus('newPassword');
    }
  }, [setFocus, token]);

  const onSubmit = handleSubmit(async ({ newPassword }) => {
    try {
      await resetMutation.mutateAsync({ token, newPassword });
      reset();
      setToken('');
    } catch {
      // The mutation state renders a deliberately generic error.
    }
  });

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="reset-title">
        <Stack gap={7}>
          <div>
            <p className="auth-card__eyebrow">HTU Graz Makerspace</p>
            <h1 id="reset-title" className="auth-card__title">
              Set a new password
            </h1>
            <p className="auth-card__subtitle">
              Reset links can be used once and expire after a short time.
            </p>
          </div>

          {!token && (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Reset token missing"
              subtitle="Open the complete reset link supplied by an administrator."
            />
          )}

          {resetMutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Unable to reset password"
              subtitle="The link may be invalid or expired. Ask an administrator for a new one."
            />
          )}

          {resetMutation.isSuccess && !token ? (
            <Stack gap={6}>
              <InlineNotification
                kind="success"
                lowContrast
                hideCloseButton
                title="Password updated"
                subtitle="You can now sign in with your new password."
              />
              <Button as={Link} to="/login" renderIcon={Checkmark}>
                Continue to sign in
              </Button>
            </Stack>
          ) : (
            <Form onSubmit={onSubmit}>
              <Stack gap={6}>
                <PasswordInput
                  id="reset-new-password"
                  autoComplete="new-password"
                  labelText="New password"
                  helperText="Use at least 12 characters."
                  invalid={Boolean(errors.newPassword)}
                  invalidText={errors.newPassword?.message}
                  disabled={!token}
                  {...register('newPassword', {
                    required: 'Enter a new password.',
                    validate: validatePasswordLength,
                  })}
                />
                <PasswordInput
                  id="reset-confirm-password"
                  autoComplete="new-password"
                  labelText="Confirm new password"
                  invalid={Boolean(errors.confirmPassword)}
                  invalidText={errors.confirmPassword?.message}
                  disabled={!token}
                  {...register('confirmPassword', {
                    required: 'Confirm the new password.',
                    validate: (value) =>
                      value === watch('newPassword') || 'The passwords do not match.',
                  })}
                />
                <Button
                  type="submit"
                  disabled={!token || resetMutation.isPending}
                >
                  {resetMutation.isPending ? 'Updating…' : 'Update password'}
                </Button>
              </Stack>
            </Form>
          )}

          <CarbonLink as={Link} to="/login" renderIcon={ArrowLeft}>
            Back to sign in
          </CarbonLink>
        </Stack>
      </section>
    </main>
  );
}
