import { type FormEvent, lazy, Suspense, useEffect, useRef, useState } from 'react';
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
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { getStartOIDCLoginUrl, listOIDCLoginProviders } from '../../api/generated/oidc/oidc';
import type { LoginRequest, PinLoginRequest, SecondFactorMethod } from '../../api/generated/models';
import { ApiError, apiErrorCode } from '../../api/http-client';
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
  // Two small forms with local state: the sign-in page is part of the initial bundle, where a form library would cost
  // more than it saves. Errors appear on submit and clear as the field changes, as elsewhere in the app.
  const [credentials, setCredentials] = useState<LoginRequest>({ email: '', password: '' });
  const [credentialErrors, setCredentialErrors] = useState<Partial<Record<keyof LoginRequest, string>>>({});
  const [pinCredentials, setPinCredentials] = useState<PinLoginRequest>({ loginName: '', pin: '' });
  const [pinErrors, setPinErrors] = useState<Partial<Record<keyof PinLoginRequest, string>>>({});
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  if (currentUser.isPending) {
    return <FullPageLoading label="Loading" />;
  }

  if (currentUser.isSuccess) {
    return <Navigate to={safeReturnPath(location.state as LocationState)} replace />;
  }

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: Partial<Record<keyof LoginRequest, string>> = {};
    if (!credentials.email.trim()) errors.email = 'Enter your email address.';
    if (!credentials.password) errors.password = 'Enter your password.';
    setCredentialErrors(errors);
    if (Object.keys(errors).length > 0) return;
    try {
      const pending = await loginMutation.mutateAsync(credentials);
      if (pending) {
        setSecondFactor(pending.methods);
        return;
      }
      navigate(safeReturnPath(location.state as LocationState), { replace: true });
    } catch {
      // The generic inline error below intentionally avoids account enumeration.
    }
  };
  const submitPIN = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: Partial<Record<keyof PinLoginRequest, string>> = {};
    if (!pinCredentials.loginName.trim()) errors.loginName = 'Enter your login name.';
    if (!pinCredentials.pin) errors.pin = 'Enter your PIN.';
    else if (!/^[0-9]{6,12}$/.test(pinCredentials.pin)) errors.pin = 'Enter 6 to 12 digits.';
    setPinErrors(errors);
    if (Object.keys(errors).length > 0) return;
    try {
      await pinLoginMutation.mutateAsync(pinCredentials);
      navigate(safeReturnPath(location.state as LocationState), { replace: true });
    } catch {
      /* generic error below */
    }
  };

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
  // The server only answers this after the credentials were right, so naming the reason leaks nothing.
  const notPermitted =
    apiErrorCode(loginMutation.error) === 'web_sign_in_not_permitted' ||
    apiErrorCode(pinLoginMutation.error) === 'web_sign_in_not_permitted';

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
                  subtitle={
                    rateLimited
                      ? 'Wait a moment before trying again.'
                      : notPermitted
                        ? 'This account may not sign in to the web application. Use the terminal at the makerspace instead.'
                        : 'The credentials are incorrect.'
                  }
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
                      ref={emailRef}
                      value={credentials.email}
                      invalid={Boolean(credentialErrors.email)}
                      invalidText={credentialErrors.email}
                      onChange={(event) => {
                        setCredentials((current) => ({ ...current, email: event.target.value }));
                        setCredentialErrors((current) => ({ ...current, email: undefined }));
                      }}
                    />
                    <PasswordInput
                      id="login-password"
                      autoComplete="current-password"
                      labelText="Password"
                      value={credentials.password}
                      invalid={Boolean(credentialErrors.password)}
                      invalidText={credentialErrors.password}
                      onChange={(event) => {
                        setCredentials((current) => ({ ...current, password: event.target.value }));
                        setCredentialErrors((current) => ({ ...current, password: undefined }));
                      }}
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
                      value={pinCredentials.loginName}
                      invalid={Boolean(pinErrors.loginName)}
                      invalidText={pinErrors.loginName}
                      onChange={(event) => {
                        setPinCredentials((current) => ({ ...current, loginName: event.target.value }));
                        setPinErrors((current) => ({ ...current, loginName: undefined }));
                      }}
                    />
                    <PasswordInput
                      id="login-pin"
                      autoComplete="current-password"
                      labelText="PIN"
                      value={pinCredentials.pin}
                      invalid={Boolean(pinErrors.pin)}
                      invalidText={pinErrors.pin}
                      onChange={(event) => {
                        setPinCredentials((current) => ({ ...current, pin: event.target.value }));
                        setPinErrors((current) => ({ ...current, pin: undefined }));
                      }}
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
