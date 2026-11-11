import {
  Button,
  ContentSwitcher,
  Form,
  InlineNotification,
  PasswordInput,
  Stack,
  Switch,
  TextInput,
} from '@carbon/react';
import { ArrowLeft, UserFollow } from '@carbon/icons-react';
import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { Visit } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { useSecretMutation } from '../../../api/use-secret-mutation';
import { CodeDigits } from './CodeDigits';
import { PinKeypad } from './PinKeypad';
import {
  checkIn,
  checkOut,
  labRulesNeed,
  requestEmailCode,
  type Credentials,
  type KioskAuthMethod,
  type LabRulesNeed,
} from './checkIn';
import { useIdleCountdown } from './useIdleCountdown';
import { useKeyboardAvoidance } from '../useKeyboardAvoidance';

const pinLength = { min: 6, max: 12 };
const emailCodeLength = 6;
const emailPattern = /^\S+@\S+\.\S+$/;
// Visitors sign in with the emailed code, so it comes first when the terminal offers it.
const methodOrder = ['email_code', 'pin', 'password'] as const;
const methodLabels: Record<KioskAuthMethod, string> = {
  email_code: 'Email code',
  pin: 'Login name and PIN',
  password: 'Email and password',
};

// Credentials are entered here for check-in and, when the kiosk has no public tap checkout, for check-out.
export function CredentialsScreen({
  mode,
  methods,
  onSuccess,
  onLabRulesNeeded,
  onCancel,
}: {
  mode: 'check-in' | 'check-out';
  methods: KioskAuthMethod[];
  onSuccess: (result: Visit) => void;
  /** Check-in was refused until the person deals with the Lab Rules; the credentials go on to that screen. */
  onLabRulesNeeded?: (credentials: Credentials, need: LabRulesNeed) => void;
  onCancel: () => void;
}) {
  const available = methodOrder.filter((item) => methods.includes(item));
  const [method, setMethod] = useState<KioskAuthMethod>(available[0] ?? 'pin');
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  useKeyboardAvoidance();
  const idleLeft = useIdleCountdown(onCancel);
  const activeMethod = available.includes(method) ? method : (available[0] ?? 'pin');
  const emailCode = activeMethod === 'email_code';
  const ready = emailCode
    ? codeSent
      ? secret.length === emailCodeLength
      : emailPattern.test(identifier.trim())
    : identifier.trim() !== '' && (activeMethod === 'pin' ? secret.length >= pinLength.min : secret !== '');
  const label = mode === 'check-in' ? 'Check in' : 'Check out';

  const attendance = useSecretMutation((credentials: Credentials): Promise<Visit> =>
    mode === 'check-in' ? checkIn(credentials) : checkOut(credentials),
  );

  // The answer is the same for every address, so only a transport failure can show here.
  const sendCode = useMutation({ mutationFn: (email: string) => requestEmailCode(email) });

  useEffect(() => {
    if (codeSent) codeInput.current?.focus();
  }, [codeSent]);

  async function send() {
    attendance.reset();
    try {
      await sendCode.mutateAsync(identifier.trim());
      setSecret('');
      setCodeSent(true);
    } catch {
      /* rendered below */
    }
  }

  async function submit() {
    if (!ready || attendance.isPending || sendCode.isPending) return;
    if (emailCode && !codeSent) {
      await send();
      return;
    }
    const credentials = { method: activeMethod, identifier: identifier.trim(), secret };
    setSecret('');
    try {
      const result = await attendance.mutateAsync(credentials);
      setIdentifier('');
      onSuccess(result);
    } catch (error) {
      // The error is shown from the mutation state; the secret is already cleared. A check-in that waits for the
      // Lab Rules hands the credentials over instead: the person confirms next and the same entries are resubmitted.
      const need = mode === 'check-in' ? labRulesNeed(error) : null;
      if (need && onLabRulesNeeded) {
        setIdentifier('');
        attendance.reset();
        onLabRulesNeeded(credentials, need);
      }
    }
  }

  function chooseMethod(next: KioskAuthMethod) {
    setMethod(next);
    setIdentifier('');
    setSecret('');
    setCodeSent(false);
    attendance.reset();
    sendCode.reset();
  }

  const error = attendance.isError && (
    <InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title={`${label} failed`}
      subtitle={errorText(attendance.error, activeMethod)}
    />
  );
  const submitButton = (
    <Button type="submit" size="2xl" className="tablet-submit" disabled={!ready || attendance.isPending}>
      {label}
    </Button>
  );

  return (
    <Form
      className="tablet-identify"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="tablet-identify__header">
        <Button kind="ghost" size="lg" renderIcon={ArrowLeft} iconDescription="Back" onClick={onCancel}>
          Back
        </Button>
      </div>

      <h1 className="tablet-identify__title">{mode === 'check-in' ? 'Who is arriving?' : 'Who is leaving?'}</h1>

      {/* First-time visitors have no credentials yet: their way in sits right under the question. */}
      {/* Once a code is on its way the screen belongs to it, so the code and keypad fit without scrolling. */}
      {mode === 'check-in' && !(emailCode && codeSent) && (
        <div className="tablet-register">
          <div>
            <p className="tablet-register__title">First time here?</p>
            <p className="tablet-register__text">
              Register as a visitor. It takes about two minutes and checks you in.
            </p>
          </div>
          <Button as={Link} to="/visitor-enrollment" size="xl" renderIcon={UserFollow}>
            Register
          </Button>
        </div>
      )}

      {available.length > 1 && !(emailCode && codeSent) && (
        <ContentSwitcher
          size="lg"
          selectedIndex={available.indexOf(activeMethod)}
          onChange={({ name }) => chooseMethod(name as KioskAuthMethod)}
        >
          {available.map((item) => (
            <Switch key={item} name={item} text={methodLabels[item]} />
          ))}
        </ContentSwitcher>
      )}

      {emailCode ? (
        <Stack gap={5} className="tablet-password">
          <div className={codeSent ? 'tablet-code-email tablet-code-email--sent' : 'tablet-code-email'}>
            <TextInput
              id="tablet-code-email"
              size="lg"
              type="email"
              labelText="Email"
              helperText={
                codeSent ? 'We sent a six-digit code to this address. It is valid for ten minutes.' : undefined
              }
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              readOnly={codeSent}
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
            />
            {codeSent && (
              <Button
                type="button"
                kind="ghost"
                size="lg"
                onClick={() => {
                  setCodeSent(false);
                  setSecret('');
                  attendance.reset();
                }}
              >
                Change email
              </Button>
            )}
          </div>
          {codeSent && (
            <CodeDigits
              id="tablet-email-code"
              inputRef={codeInput}
              length={emailCodeLength}
              value={secret}
              onChange={setSecret}
            />
          )}
          {codeSent && (
            <PinKeypad
              label="Code keypad"
              onDigit={(digit) => {
                setSecret((current) => (current.length < emailCodeLength ? current + digit : current));
              }}
              onBackspace={() => setSecret((current) => current.slice(0, -1))}
              onClear={() => setSecret('')}
            />
          )}
          {codeSent && (
            <p className="tablet-code-hint">
              No code? Check your spam folder. You can request up to five codes every 15 minutes.
            </p>
          )}
          {sendCode.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Code not sent"
              subtitle="The code could not be sent. Try again in a moment."
            />
          )}
          {error}
          {codeSent ? (
            <div className="tablet-code-actions">
              <Button
                type="button"
                kind="tertiary"
                size="2xl"
                disabled={sendCode.isPending}
                onClick={() => void send()}
              >
                Send a new code
              </Button>
              {submitButton}
            </div>
          ) : (
            <Button type="submit" size="2xl" className="tablet-submit" disabled={!ready || sendCode.isPending}>
              {sendCode.isPending ? 'Sending…' : 'Send code'}
            </Button>
          )}
        </Stack>
      ) : activeMethod === 'pin' ? (
        <div className="tablet-pin">
          <Stack gap={5}>
            <TextInput
              id="tablet-login-name"
              size="lg"
              labelText="Login name"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
            />
            <div>
              <p className="cds--label" id="tablet-pin-label">
                PIN
              </p>
              <div className="tablet-pin__display" aria-labelledby="tablet-pin-label">
                <span className="tablet-pin__mask" aria-hidden="true">
                  {secret.length > 0 ? '•'.repeat(secret.length) : <span>Use the keypad</span>}
                </span>
                <span className="tablet-pin__count" aria-hidden="true">
                  {secret.length} {secret.length === 1 ? 'digit' : 'digits'} · {pinLength.min}–{pinLength.max}
                </span>
                <span className="cds--visually-hidden" role="status">
                  {secret.length} digits entered
                </span>
              </div>
            </div>
            {error}
            {submitButton}
          </Stack>
          <PinKeypad
            onDigit={(digit) => {
              setSecret((current) => (current.length < pinLength.max ? current + digit : current));
            }}
            onBackspace={() => setSecret((current) => current.slice(0, -1))}
            onClear={() => setSecret('')}
          />
        </div>
      ) : (
        <Stack gap={5} className="tablet-password">
          <TextInput
            id="tablet-email"
            size="lg"
            type="email"
            labelText="Email"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
          />
          <PasswordInput
            id="tablet-password"
            size="lg"
            labelText="Password"
            autoComplete="off"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
          {error}
          {submitButton}
        </Stack>
      )}

      <p className="tablet-identify__idle">
        {idleLeft <= 15
          ? `No activity — returning to the start screen in ${idleLeft} s.`
          : 'Your entries are cleared when you leave this screen.'}
      </p>
    </Form>
  );
}

// The API answers wrong names and wrong secrets alike with 401; name the credentials actually used on this screen.
function errorText(error: Error, method: KioskAuthMethod) {
  if (error instanceof ApiError && error.status === 401) {
    if (method === 'email_code') return 'The code is not correct or has expired.';
    return method === 'pin' ? 'The login name or PIN is not correct.' : 'The email or password is not correct.';
  }
  return error.message;
}
