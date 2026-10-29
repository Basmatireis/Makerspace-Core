import { lazy, Suspense, useState } from 'react';
import {
  Button,
  CodeSnippet,
  InlineNotification,
  Link as CarbonLink,
  SkeletonPlaceholder,
  Stack,
  TextInput,
} from '@carbon/react';
import { Download, FingerprintRecognition } from '@carbon/icons-react';
import { useMutation } from '@tanstack/react-query';
import type { SecondFactorEnrollmentResult } from '../../../api/generated/models';
import {
  confirmTotpEnrollment,
  registerPasskey,
  startPasskeyRegistration,
  startTotpEnrollment,
} from '../../../api/generated/authentication/authentication';
import { useSecretMutation } from '../../../api/use-secret-mutation';
import { createPasskeyCredential, describeAuthenticationError } from './webauthn';

const QrCode = lazy(() => import('./QrCode'));

function Failure({ error, title }: { error: unknown; title: string }) {
  if (error == null) return null;
  return (
    <InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title={title}
      subtitle={describeAuthenticationError(error)}
    />
  );
}

/** Authenticator app enrollment: the secret is shown once for manual entry or an otpauth link, then confirmed. */
export function TotpEnrollmentPanel({ onEnrolled }: { onEnrolled: (result: SecondFactorEnrollmentResult) => void }) {
  const [code, setCode] = useState('');
  const start = useMutation({ mutationFn: () => startTotpEnrollment() });
  const confirm = useSecretMutation((value: string) => confirmTotpEnrollment({ code: value }), {
    onSuccess: onEnrolled,
  });
  const enrollment = start.data;

  if (!enrollment) {
    return (
      <Stack gap={5}>
        <Failure error={start.error} title="Unable to start setup" />
        <p>Use an authenticator app such as a password manager or a one-time-code app.</p>
        <div>
          <Button kind="tertiary" disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? 'Starting…' : 'Set up authenticator app'}
          </Button>
        </div>
      </Stack>
    );
  }
  const otpauthLink = enrollment.otpauthUri.startsWith('otpauth://') ? enrollment.otpauthUri : null;
  return (
    <Stack gap={5}>
      <p>
        Scan the QR code with your authenticator app, or enter the key below manually
        {otpauthLink && (
          <>
            {' '}
            or <CarbonLink href={otpauthLink}>open it in an authenticator app on this device</CarbonLink>
          </>
        )}
        . Then enter the six-digit code it shows.
      </p>
      <Suspense fallback={<SkeletonPlaceholder style={{ width: 200, height: 200 }} />}>
        <QrCode value={enrollment.otpauthUri} label="QR code for your authenticator app" />
      </Suspense>
      <CodeSnippet type="single" feedback="Copied" aria-label="Setup key" copyButtonDescription="Copy setup key">
        {enrollment.secret}
      </CodeSnippet>
      <Failure error={confirm.error} title="Unable to confirm" />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void confirm.mutateAsync(code.trim()).catch(() => setCode(''));
        }}
      >
        <Stack gap={5}>
          <TextInput
            id="totp-confirm-code"
            labelText="Authentication code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
          />
          <div>
            <Button type="submit" disabled={confirm.isPending || !/^[0-9]{6}$/.test(code.trim())}>
              {confirm.isPending ? 'Confirming…' : 'Confirm and turn on'}
            </Button>
          </div>
        </Stack>
      </form>
    </Stack>
  );
}

/** Registers a passkey on this device or a security key. Hidden by callers when WebAuthn is unavailable. */
export function PasskeyRegistrationPanel({
  onEnrolled,
}: {
  onEnrolled: (result: SecondFactorEnrollmentResult) => void;
}) {
  const [name, setName] = useState('Passkey');
  const register = useMutation({
    mutationFn: async (passkeyName: string) => {
      const options = await startPasskeyRegistration();
      return registerPasskey({ name: passkeyName, credential: await createPasskeyCredential(options) });
    },
    onSuccess: onEnrolled,
  });
  return (
    <Stack gap={5}>
      <Failure error={register.error} title="Unable to register the passkey" />
      <p>A passkey uses your fingerprint, face, screen lock or a security key.</p>
      <TextInput
        id="passkey-name"
        labelText="Passkey name"
        helperText="For example the device it lives on."
        value={name}
        maxLength={100}
        onChange={(event) => setName(event.target.value)}
      />
      <div>
        <Button
          kind="tertiary"
          renderIcon={FingerprintRecognition}
          disabled={register.isPending || !name.trim()}
          onClick={() => register.mutate(name.trim())}
        >
          {register.isPending ? 'Waiting for passkey…' : 'Register passkey'}
        </Button>
      </div>
    </Stack>
  );
}

/** Shows single-use recovery codes. They are returned only once, so copying or saving them is offered here. */
export function RecoveryCodesPanel({
  codes,
  onDone,
  doneLabel = 'I have saved these codes',
}: {
  codes: readonly string[];
  onDone: () => void;
  doneLabel?: string;
}) {
  const text = codes.join('\n');
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Stack gap={5}>
      <InlineNotification
        kind="warning"
        lowContrast
        hideCloseButton
        title="Save your recovery codes"
        subtitle="Each code works once if you lose your second factor. They are shown only now."
      />
      <CodeSnippet
        type="multi"
        feedback="Copied"
        copyButtonDescription="Copy recovery codes"
        aria-label="Recovery codes"
      >
        {text}
      </CodeSnippet>
      <div className="button-cluster">
        <Button kind="tertiary" size="md" renderIcon={Download} onClick={download}>
          Download as .txt
        </Button>
        <Button onClick={onDone}>{doneLabel}</Button>
      </div>
    </Stack>
  );
}
