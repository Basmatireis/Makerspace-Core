import { useEffect } from 'react';
import {
  Button,
  Form,
  InlineNotification,
  Link as CarbonLink,
  PasswordInput,
  Stack,
  TextInput,
} from '@carbon/react';
import { Login } from '@carbon/icons-react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { LoginRequest } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { FullPageLoading } from '../../app/PageState';
import { useCurrentUserQuery, useLogin } from './auth';

type LocationState = { from?: string } | null;

function safeReturnPath(state: LocationState): string {
  const path = state?.from;
  return path?.startsWith('/') && !path.startsWith('//') ? path : '/dashboard';
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const currentUser = useCurrentUserQuery();
  const loginMutation = useLogin();
  const {
    register,
    handleSubmit,
    formState: { errors },
    setFocus,
  } = useForm<LoginRequest>({
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  if (currentUser.isPending) {
    return <FullPageLoading label="Loading" />;
  }

  if (currentUser.isSuccess) {
    return <Navigate to={safeReturnPath(location.state as LocationState)} replace />;
  }

  const onSubmit = handleSubmit(async (values) => {
    try {
      await loginMutation.mutateAsync(values);
      navigate(safeReturnPath(location.state as LocationState), { replace: true });
    } catch {
      // The generic inline error below intentionally avoids account enumeration.
    }
  });

  const rateLimited =
    loginMutation.error instanceof ApiError && loginMutation.error.status === 429;

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <Stack gap={7}>
          <div>
            <p className="auth-card__eyebrow">HTU Graz</p>
            <h1 id="login-title" className="auth-card__title">
              Makerspace
            </h1>
            <p className="auth-card__subtitle">Sign in to continue.</p>
          </div>

          {loginMutation.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title={rateLimited ? 'Too many attempts' : 'Unable to sign in'}
              subtitle={
                rateLimited
                  ? 'Wait a moment before trying again.'
                  : 'The email or password is incorrect.'
              }
            />
          )}

          <Form onSubmit={onSubmit}>
            <Stack gap={6}>
              <TextInput
                id="login-email"
                type="email"
                autoComplete="username"
                labelText="Email"
                invalid={Boolean(errors.email)}
                invalidText={errors.email?.message}
                {...register('email', {
                  required: 'Enter your email address.',
                })}
              />
              <PasswordInput
                id="login-password"
                autoComplete="current-password"
                labelText="Password"
                invalid={Boolean(errors.password)}
                invalidText={errors.password?.message}
                {...register('password', { required: 'Enter your password.' })}
              />
              <Button
                type="submit"
                renderIcon={Login}
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
              </Button>
            </Stack>
          </Form>

          <p className="auth-card__help">
            Need a new password? Ask a makerspace administrator for a reset link.
          </p>
          <CarbonLink as={Link} to="/reset-password" className="visually-hidden">
            Redeem a password reset link
          </CarbonLink>
        </Stack>
      </section>
    </main>
  );
}
