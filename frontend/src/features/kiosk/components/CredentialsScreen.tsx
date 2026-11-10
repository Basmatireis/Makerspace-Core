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
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Visit } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { useSecretMutation } from '../../../api/use-secret-mutation';
import { PinKeypad } from './PinKeypad';
import { checkIn, checkOut, labRulesNeed, type Credentials, type KioskAuthMethod, type LabRulesNeed } from './checkIn';
import { useIdleCountdown } from './useIdleCountdown';
import { useKeyboardAvoidance } from '../useKeyboardAvoidance';

const pinLength = { min: 6, max: 12 };

// Credentials are entered here for check-in and, when the kiosk has no public tap checkout, for check-out.
export function CredentialsScreen({
  mode,
  methods,
  onSuccess,
  onLabRulesNeeded,
  onCancel,
}: {
  mode: 'check-in' | 'check-out';
  methods: string[];
  onSuccess: (result: Visit) => void;
  /** Check-in was refused until the person deals with the Lab Rules; the credentials go on to that screen. */
  onLabRulesNeeded?: (credentials: Credentials, need: LabRulesNeed) => void;
  onCancel: () => void;
}) {
  const available = (['pin', 'password'] as const).filter((item) => methods.includes(item));
  const [method, setMethod] = useState<KioskAuthMethod>(available[0] ?? 'pin');
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  useKeyboardAvoidance();
  const idleLeft = useIdleCountdown(onCancel);
  const activeMethod = available.includes(method) ? method : (available[0] ?? 'pin');
  const ready = identifier.trim() !== '' && (activeMethod === 'pin' ? secret.length >= pinLength.min : secret !== '');
  const label = mode === 'check-in' ? 'Check in' : 'Check out';

  const attendance = useSecretMutation((credentials: Credentials): Promise<Visit> =>
    mode === 'check-in' ? checkIn(credentials) : checkOut(credentials),
  );

  async function submit() {
    if (!ready || attendance.isPending) return;
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
    attendance.reset();
  }

  const error = attendance.isError && (
    <InlineNotification
      kind="error"
      lowContrast
      hideCloseButton
      title={`${label} failed`}
      subtitle={errorText(attendance.error, method)}
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
      {mode === 'check-in' && (
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

      {available.length > 1 && (
        <ContentSwitcher
          size="lg"
          selectedIndex={activeMethod === 'pin' ? 0 : 1}
          onChange={({ name }) => chooseMethod(name as KioskAuthMethod)}
        >
          <Switch name="pin" text="Login name and PIN" />
          <Switch name="password" text="Email and password" />
        </ContentSwitcher>
      )}

      {activeMethod === 'pin' ? (
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
    return method === 'pin' ? 'The login name or PIN is not correct.' : 'The email or password is not correct.';
  }
  return error.message;
}
