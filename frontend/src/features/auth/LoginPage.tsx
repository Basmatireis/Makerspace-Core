import { useEffect, useState } from 'react';
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
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { getStartOIDCLoginUrl, listOIDCLoginProviders } from '../../api/generated/oidc/oidc';
import type { LoginRequest, PinLoginRequest } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { FullPageLoading } from '../../app/PageState';
import { useCurrentUserQuery, useLogin, usePINLogin } from './auth';

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
  const pinLoginMutation = usePINLogin();
  const oidcProviders = useQuery({
    queryKey: ['oidc', 'login-providers'],
    queryFn: ({ signal }) => listOIDCLoginProviders({ signal }),
  });
  const [method, setMethod] = useState<'password' | 'pin'>('password');
  const {
    register,
    handleSubmit,
    formState: { errors },
    setFocus,
  } = useForm<LoginRequest>({
    defaultValues: { email: '', password: '' },
  });
  const pinForm = useForm<PinLoginRequest>({ defaultValues: { loginName: '', pin: '' } });

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
  const submitPIN = pinForm.handleSubmit(async (values) => {
    try {
      await pinLoginMutation.mutateAsync(values);
      navigate(safeReturnPath(location.state as LocationState), { replace: true });
    } catch { /* generic error below */ }
  });

  const rateLimited =
    (loginMutation.error instanceof ApiError && loginMutation.error.status === 429) ||
    (pinLoginMutation.error instanceof ApiError && pinLoginMutation.error.status === 429);
  const loginError = loginMutation.isError || pinLoginMutation.isError;

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

          {loginError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title={rateLimited ? 'Too many attempts' : 'Unable to sign in'}
              subtitle={
                rateLimited
                  ? 'Wait a moment before trying again.'
                  : 'The credentials are incorrect.'
              }
            />
          )}

          <div className="button-cluster" aria-label="Authentication method">
            <Button size="sm" kind={method === 'password' ? 'primary' : 'ghost'} onClick={() => setMethod('password')}>Password</Button>
            <Button size="sm" kind={method === 'pin' ? 'primary' : 'ghost'} onClick={() => setMethod('pin')}>PIN</Button>
          </div>

          {method === 'password' ? <Form onSubmit={onSubmit}>
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
          </Form> : <Form onSubmit={submitPIN}>
            <Stack gap={6}>
              <TextInput id="pin-login-name" autoComplete="username" labelText="Login name" invalid={Boolean(pinForm.formState.errors.loginName)} invalidText={pinForm.formState.errors.loginName?.message} {...pinForm.register('loginName', { required: 'Enter your login name.' })} />
              <PasswordInput id="login-pin" autoComplete="current-password" labelText="PIN" invalid={Boolean(pinForm.formState.errors.pin)} invalidText={pinForm.formState.errors.pin?.message} {...pinForm.register('pin', { required: 'Enter your PIN.', pattern: { value: /^[0-9]{6,12}$/, message: 'Enter 6 to 12 digits.' } })} />
              <Button type="submit" renderIcon={Login} disabled={pinLoginMutation.isPending}>{pinLoginMutation.isPending ? 'Signing in…' : 'Sign in with PIN'}</Button>
            </Stack>
          </Form>}

          {oidcProviders.data && oidcProviders.data.items.length > 0 && (
            <Stack gap={4}>
              <p className="auth-card__help">Or continue with your organization</p>
              {oidcProviders.data.items.map((provider) => (
                <Button
                  key={provider.slug}
                  kind="tertiary"
                  onClick={() => window.location.assign(getStartOIDCLoginUrl(provider.slug))}
                >
                  Continue with {provider.displayName}
                </Button>
              ))}
            </Stack>
          )}

          <p className="auth-card__help">
            Forgot your password? Request a one-time reset code.
          </p>
          <CarbonLink as={Link} to="/reset-password">
            Reset password
          </CarbonLink>
        </Stack>
      </section>
    </main>
  );
}
