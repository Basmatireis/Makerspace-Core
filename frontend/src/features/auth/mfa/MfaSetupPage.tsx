import { useState } from 'react';
import { Button, InlineNotification, Stack, Tile } from '@carbon/react';
import { useQueryClient } from '@tanstack/react-query';
import type { SecondFactorEnrollmentResult } from '../../../api/generated/models';
import { BrandMark } from '../../../app/BrandMark';
import { authQueryKey, useCurrentUser, useLogout } from '../auth';
import { PasskeyRegistrationPanel, RecoveryCodesPanel, TotpEnrollmentPanel } from './EnrollmentPanels';
import { canUsePasskeys } from './webauthn';

/** Full-page forced enrollment, shown instead of the application while `authentication.mfaSetupRequired` is set. */
export function MfaSetupPage() {
  const queryClient = useQueryClient();
  const { authentication } = useCurrentUser();
  const logout = useLogout();
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const reload = () => queryClient.invalidateQueries({ queryKey: authQueryKey });

  // Recovery codes are shown before the current user is reloaded: the reload ends the forced setup and this page.
  const enrolled = (result: SecondFactorEnrollmentResult) => {
    if (result.recoveryCodes?.length) setCodes(result.recoveryCodes);
    else void reload();
  };

  return (
    <main className="auth-page auth-page--login">
      <section className="auth-card" aria-labelledby="mfa-setup-title">
        <Stack gap={6}>
          <div className="auth-card__heading">
            <div className="auth-card__brand">
              <BrandMark kind="logo" className="auth-card__logo" />
              <h1 id="mfa-setup-title">Set up a second factor</h1>
            </div>
            <p className="auth-card__subtitle">
              {authentication.mfaRequired
                ? 'Your account holds a role that requires a second factor.'
                : 'A second factor is required before you can continue.'}{' '}
              Add an authenticator app or a passkey to keep your account safe.
            </p>
          </div>
          {codes ? (
            <RecoveryCodesPanel codes={codes} onDone={() => void reload()} />
          ) : (
            <>
              <Tile>
                <TotpEnrollmentPanel onEnrolled={enrolled} />
              </Tile>
              {canUsePasskeys() && (
                <Tile>
                  <PasskeyRegistrationPanel onEnrolled={enrolled} />
                </Tile>
              )}
              {logout.isError && (
                <InlineNotification kind="error" lowContrast hideCloseButton title="Unable to sign out" />
              )}
              <div>
                <Button kind="ghost" onClick={() => logout.mutate()}>
                  Sign out
                </Button>
              </div>
            </>
          )}
        </Stack>
      </section>
    </main>
  );
}
