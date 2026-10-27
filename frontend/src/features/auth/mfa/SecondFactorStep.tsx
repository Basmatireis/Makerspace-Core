import { useState } from 'react';
import { Button, Form, InlineNotification, Stack, TextInput } from '@carbon/react';
import { FingerprintRecognition, Login } from '@carbon/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import type { SecondFactorMethod } from '../../../api/generated/models';
import {
  completeSecondFactorLogin,
  completeSecondFactorPasskey,
  startSecondFactorPasskey,
} from '../../../api/generated/authentication/authentication';
import { useSecretMutation } from '../../../api/use-secret-mutation';
import { currentUserQueryOptions } from '../auth';
import { describeAuthenticationError, getPasskeyCredential, isPendingLoginExpired } from './webauthn';

type Props = {
  methods: readonly SecondFactorMethod[];
  onRestart: () => void;
  onDone: () => void;
};

/** The step after a password login that answered 202: authenticator code, recovery code or passkey. */
export function SecondFactorStep({ methods, onRestart, onDone }: Props) {
  const queryClient = useQueryClient();
  const hasTotp = methods.includes('totp');
  const hasRecovery = methods.includes('recovery_code');
  const hasPasskey = methods.includes('passkey') && typeof window.PublicKeyCredential !== 'undefined';
  const [useRecoveryCode, setUseRecoveryCode] = useState(!hasTotp && hasRecovery);
  const [code, setCode] = useState('');
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeyError, setPasskeyError] = useState<unknown>(null);

  const finish = async () => {
    await queryClient.fetchQuery(currentUserQueryOptions());
    onDone();
  };
  const codeMutation = useSecretMutation(
    (value: { method: 'totp' | 'recovery_code'; code: string }) => completeSecondFactorLogin(value),
    { onSuccess: finish },
  );

  const error = codeMutation.error ?? passkeyError;
  const expired = isPendingLoginExpired(error);

  const submit = async () => {
    try {
      await codeMutation.mutateAsync({ method: useRecoveryCode ? 'recovery_code' : 'totp', code: code.trim() });
    } catch {
      setCode('');
    }
  };
  const usePasskey = async () => {
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      const options = await startSecondFactorPasskey();
      await completeSecondFactorPasskey({ credential: await getPasskeyCredential(options) });
      await finish();
    } catch (caught) {
      setPasskeyError(caught);
    } finally {
      setPasskeyBusy(false);
    }
  };

  return (
    <Form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Stack gap={6}>
        <p className="auth-card__help">
          {useRecoveryCode
            ? 'Enter one of your recovery codes. Each code works once.'
            : 'Enter the six-digit code from your authenticator app.'}
        </p>
        {error != null && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={expired ? 'Sign-in expired' : 'Unable to verify'}
            subtitle={describeAuthenticationError(error)}
          />
        )}
        {!expired && (hasTotp || hasRecovery) && (
          <TextInput
            id="second-factor-code"
            labelText={useRecoveryCode ? 'Recovery code' : 'Authentication code'}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode={useRecoveryCode ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            maxLength={useRecoveryCode ? 32 : 6}
          />
        )}
        {!expired && (hasTotp || hasRecovery) && (
          <Button type="submit" renderIcon={Login} disabled={codeMutation.isPending || code.trim().length < 6}>
            {codeMutation.isPending ? 'Verifying…' : 'Verify'}
          </Button>
        )}
        {!expired && hasPasskey && (
          <Button kind="tertiary" renderIcon={FingerprintRecognition} disabled={passkeyBusy} onClick={usePasskey}>
            Use a passkey
          </Button>
        )}
        {!expired && hasTotp && hasRecovery && (
          <Button
            kind="ghost"
            size="sm"
            onClick={() => {
              setUseRecoveryCode(!useRecoveryCode);
              setCode('');
            }}
          >
            {useRecoveryCode ? 'Use an authenticator code' : 'Use a recovery code'}
          </Button>
        )}
        <Button kind={expired ? 'primary' : 'ghost'} size={expired ? 'md' : 'sm'} onClick={onRestart}>
          {expired ? 'Start again' : 'Back to sign in'}
        </Button>
      </Stack>
    </Form>
  );
}
