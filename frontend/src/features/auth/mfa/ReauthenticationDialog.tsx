import { useState } from 'react';
import { Button, InlineNotification, Modal, PasswordInput, Stack, TextInput } from '@carbon/react';
import { FingerprintRecognition } from '@carbon/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { CurrentAuthentication, CurrentUser, ReauthenticateRequest } from '../../../api/generated/models';
import {
  completePasskeyReauthentication,
  reauthenticate,
  startPasskeyReauthentication,
} from '../../../api/generated/authentication/authentication';
import type { ReauthenticationRequest } from '../../../api/http-client';
import { useSecretMutation } from '../../../api/use-secret-mutation';
import { authQueryKey } from '../auth';
import { describeAuthenticationError, getPasskeyCredential } from './webauthn';

type Props = { request: ReauthenticationRequest; onFinish: (confirmed: boolean) => void };

export function ReauthenticationDialog({ request, onFinish }: Props) {
  const queryClient = useQueryClient();
  const methods = queryClient.getQueryData<CurrentUser>(authQueryKey)?.authentication.secondFactorMethods ?? [];
  const hasCode = methods.includes('totp') || methods.includes('recovery_code');
  const hasPasskey = methods.includes('passkey') && typeof window.PublicKeyCredential !== 'undefined';
  // An account whose only factor is a passkey proves itself with the passkey; everyone else sends the password.
  const passkeyOnly = hasPasskey && !hasCode;
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(!methods.includes('totp') && methods.includes('recovery_code'));
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<unknown>(null);

  const succeed = (authentication: CurrentAuthentication) => {
    queryClient.setQueryData<CurrentUser>(authQueryKey, (user) => {
      if (!user) return user;
      // The permissions that were withheld until this fresh sign-in are granted again from now on. Move them into the
      // permission list at once, so a page that needed one of them is not sent away while the user is refetched.
      const stillWithheld = new Set(authentication.reauthenticationRequired.map((entry) => entry.permissionId));
      const granted = user.authentication.reauthenticationRequired
        .map((entry) => entry.permissionId)
        .filter((permission) => !stillWithheld.has(permission) && !user.permissions.includes(permission));
      return { ...user, authentication, permissions: [...user.permissions, ...granted] };
    });
    void queryClient.invalidateQueries({ queryKey: authQueryKey });
    onFinish(true);
  };
  const mutation = useSecretMutation((body: ReauthenticateRequest) => reauthenticate(body), { onSuccess: succeed });

  const passkey = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const options = await startPasskeyReauthentication();
      succeed(await completePasskeyReauthentication({ credential: await getPasskeyCredential(options) }));
    } catch (error) {
      setPasskeyError(error);
    } finally {
      setPasskeyBusy(false);
    }
  };
  const submit = () => {
    const body: ReauthenticateRequest = { password };
    if (hasCode) {
      if (recovery) body.recoveryCode = code.trim();
      else body.totpCode = code.trim();
    }
    mutation.mutateAsync(body).catch(() => {
      setPassword('');
      setCode('');
    });
  };

  const error = mutation.error ?? passkeyError;
  const ready = passkeyOnly || (password.length > 0 && (!hasCode || code.trim().length >= 6));
  return (
    <Modal
      open
      size="sm"
      modalHeading="Confirm it's you"
      primaryButtonText={passkeyOnly ? 'Use passkey' : 'Confirm'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!ready || mutation.isPending || passkeyBusy}
      preventCloseOnClickOutside
      onRequestClose={() => onFinish(false)}
      onSecondarySubmit={() => onFinish(false)}
      onRequestSubmit={() => (passkeyOnly ? void passkey() : submit())}
    >
      <Stack gap={5}>
        <p>
          This action needs a recent sign-in
          {request.withinMinutes ? ` (within the last ${request.withinMinutes} minutes)` : ''}. Confirm it's you to
          continue.
        </p>
        {error != null && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Unable to confirm"
            subtitle={describeAuthenticationError(error)}
          />
        )}
        {!passkeyOnly && (
          <PasswordInput
            id="reauthenticate-password"
            labelText="Password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
        {hasCode && (
          <>
            <TextInput
              id="reauthenticate-code"
              labelText={recovery ? 'Recovery code' : 'Authentication code'}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              inputMode={recovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              maxLength={recovery ? 32 : 6}
            />
            {methods.includes('totp') && methods.includes('recovery_code') && (
              <div>
                <Button
                  kind="ghost"
                  size="sm"
                  onClick={() => {
                    setRecovery(!recovery);
                    setCode('');
                  }}
                >
                  {recovery ? 'Use an authenticator code' : 'Use a recovery code'}
                </Button>
              </div>
            )}
          </>
        )}
        {hasPasskey && hasCode && (
          <div>
            <Button kind="tertiary" renderIcon={FingerprintRecognition} disabled={passkeyBusy} onClick={passkey}>
              Use a passkey instead
            </Button>
          </div>
        )}
      </Stack>
    </Modal>
  );
}
