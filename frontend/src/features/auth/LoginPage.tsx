import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Button,
  Form,
  InlineNotification,
  Link as CarbonLink,
  PasswordInput,
  Stack,
  TextInput,
  Tile,
} from '@carbon/react';
import { ArrowLeft, FingerprintRecognition, Login } from '@carbon/icons-react';
import { useForm } from 'react-hook-form';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { getStartOIDCLoginUrl, listOIDCLoginProviders } from '../../api/generated/oidc/oidc';
import type { LoginRequest, PinLoginRequest, SecondFactorMethod } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { BrandMark } from '../../app/BrandMark';
import { FullPageLoading } from '../../app/PageState';
import { currentUserQueryOptions, useCurrentUserQuery, useLogin, usePINLogin } from './auth';
import { useBranding, usePageTitle } from '../branding/branding';
import { LegalLinks } from '../branding/LegalLinks';

// Second-factor and passkey code (including the base64url helpers) loads only when someone needs it.
const SecondFactorStep = lazy(() =>
  import('./mfa/SecondFactorStep').then(({ SecondFactorStep }) => ({ default: SecondFactorStep })),
);

// `origin: 'kiosk'` is set by the entrance kiosk's staff link so this page can offer the way back.
type LocationState = { from?: string; origin?: string } | null;

function safeReturnPath(state: LocationState): string {
  const path = state?.from;
  return path?.startsWith('/') && !path.startsWith('//') ? path : '/dashboard';
}

export function LoginPage() {
  const branding = useBranding();
  usePageTitle('Sign in');
  const navigate = useNavigate();
  const location = useLocation();
  const currentUser = useCurrentUserQuery();
  const queryClient = useQueryClient();
  const [secondFactor, setSecondFactor] = useState<readonly SecondFactorMethod[] | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const loginMutation = useLogin();
  const pinLoginMutation = usePINLogin();
  const oidcProviders = useQuery({
    queryKey: ['oidc', 'login-providers'],
    queryFn: ({ signal }) => listOIDCLoginProviders({ signal }),
  });
  const fromKiosk = (location.state as LocationState)?.origin === 'kiosk';
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
      const pending = await loginMutation.mutateAsync(values);
      if (pending) {
        setSecondFactor(pending.methods);
        return;
      }
      navigate(safeReturnPath(location.state as LocationState), { replace: true });
    } catch {
      // The generic inline error below intentionally avoids account enumeration.
    }
  });
  const submitPIN = pinForm.handleSubmit(async (values) => {
    try {
      await pinLoginMutation.mutateAsync(values);
      navigate(safeReturnPath(location.state as LocationState), { replace: true });
    } catch {
      /* generic error below */
    }
  });

  const signInWithPasskey = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const passkeys = await import('./mfa/passkeyLogin');
      try {
        await passkeys.signInWithPasskey();
        await queryClient.fetchQuery(currentUserQueryOptions());
        navigate(safeReturnPath(location.state as LocationState), { replace: true });
      } catch (error) {
        setPasskeyError(passkeys.describeAuthenticationError(error));
      }
    } catch {
      setPasskeyError('Something went wrong. Try again.');
    } finally {
      setPasskeyBusy(false);
    }
  };

  const rateLimited =
    (loginMutation.error instanceof ApiError && loginMutation.error.status === 429) ||
    (pinLoginMutation.error instanceof ApiError && pinLoginMutation.error.status === 429);
  const loginError = loginMutation.isError || pinLoginMutation.isError;

  return (
    <main className="auth-page auth-page--login">
      <section className="auth-card" aria-labelledby="login-title">
        <Stack gap={6}>
          {fromKiosk && (
            <div>
              <Button as={Link} to="/kiosk" kind="ghost" size="md" renderIcon={ArrowLeft}>
                Back to kiosk
              </Button>
            </div>
          )}
          <div className="auth-card__heading">
            <div className="auth-card__brand">
              <BrandMark kind="logo" className="auth-card__logo" />
              <div className="auth-card__wordmark">
                <span>{branding.identity.legalOrganizationName}</span>
                <h1 id="login-title">{branding.identity.displayName}</h1>
              </div>
            </div>
            <p className="auth-card__subtitle">Sign in to continue.</p>
          </div>

          {secondFactor ? (
            <Suspense fallback={<FullPageLoading label="Loading" />}>
              <SecondFactorStep
                methods={secondFactor}
                onRestart={() => setSecondFactor(null)}
                onDone={() => navigate(safeReturnPath(location.state as LocationState), { replace: true })}
              />
            </Suspense>
          ) : (
            <>
              {loginError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title={rateLimited ? 'Too many attempts' : 'Unable to sign in'}
                  subtitle={rateLimited ? 'Wait a moment before trying again.' : 'The credentials are incorrect.'}
                />
              )}

              <div className="button-cluster" aria-label="Authentication method">
                <Button
                  size="sm"
                  kind={method === 'password' ? 'primary' : 'ghost'}
                  onClick={() => setMethod('password')}
                >
                  Password
                </Button>
                <Button size="sm" kind={method === 'pin' ? 'primary' : 'ghost'} onClick={() => setMethod('pin')}>
                  PIN
                </Button>
              </div>

              {method === 'password' ? (
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
                    <Button type="submit" renderIcon={Login} disabled={loginMutation.isPending}>
                      {loginMutation.isPending ? 'Signing in…' : 'Sign in'}
                    </Button>
                  </Stack>
                </Form>
              ) : (
                <Form onSubmit={submitPIN}>
                  <Stack gap={6}>
                    <TextInput
                      id="pin-login-name"
                      autoComplete="username"
                      labelText="Login name"
                      invalid={Boolean(pinForm.formState.errors.loginName)}
                      invalidText={pinForm.formState.errors.loginName?.message}
                      {...pinForm.register('loginName', { required: 'Enter your login name.' })}
                    />
                    <PasswordInput
                      id="login-pin"
                      autoComplete="current-password"
                      labelText="PIN"
                      invalid={Boolean(pinForm.formState.errors.pin)}
                      invalidText={pinForm.formState.errors.pin?.message}
                      {...pinForm.register('pin', {
                        required: 'Enter your PIN.',
                        pattern: { value: /^[0-9]{6,12}$/, message: 'Enter 6 to 12 digits.' },
                      })}
                    />
                    <Button type="submit" renderIcon={Login} disabled={pinLoginMutation.isPending}>
                      {pinLoginMutation.isPending ? 'Signing in…' : 'Sign in with PIN'}
                    </Button>
                  </Stack>
                </Form>
              )}

              {typeof window.PublicKeyCredential !== 'undefined' && (
                <Stack gap={4}>
                  {passkeyError && (
                    <InlineNotification
                      kind="error"
                      lowContrast
                      hideCloseButton
                      title="Unable to sign in with a passkey"
                      subtitle={passkeyError}
                    />
                  )}
                  <Button
                    kind="tertiary"
                    renderIcon={FingerprintRecognition}
                    disabled={passkeyBusy}
                    onClick={signInWithPasskey}
                  >
                    Sign in with passkey
                  </Button>
                </Stack>
              )}

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
            </>
          )}

          <Tile className="auth-card__support">
            <p className="auth-card__support-title">Need access?</p>
            <p className="auth-card__help">
              Accounts are provided by the {branding.identity.displayName} team. If you already have one but cannot sign
              in, request a one-time reset code.
            </p>
            <CarbonLink as={Link} to="/reset-password">
              Reset password
            </CarbonLink>
          </Tile>
          <LegalLinks className="auth-card__legal" />
        </Stack>
      </section>
    </main>
  );
}
