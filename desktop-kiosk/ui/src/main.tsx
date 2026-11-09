import { Button, Checkbox, Form, InlineNotification, PasswordInput, Stack, TextInput, Tile } from '@carbon/react';
import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.scss';

declare global {
  interface Window {
    __TAURI__: { core: { invoke<T>(command: string, arguments_?: Record<string, unknown>): Promise<T> } };
    makerspaceDesktopDebug?: boolean;
  }
}

type PairingCode = { code: string; expiresAt: string };
type PollStatus = 'pending' | 'expired' | 'paired';

const POLL_MS = 3_000;

const invoke = <T,>(command: string, arguments_?: Record<string, unknown>) =>
  window.__TAURI__.core.invoke<T>(command, arguments_);

const errorText = (error: unknown, fallback: string) => (typeof error === 'string' ? error : fallback);

const clockText = (milliseconds: number) => {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

function RegistrationApp() {
  const [coreURL, setCoreURL] = useState('');
  const [token, setToken] = useState('');
  const [simulator, setSimulator] = useState(false);
  const [manual, setManual] = useState(false);
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const debug = window.makerspaceDesktopDebug === true;

  useEffect(() => {
    const registrationError = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      setMessage({ kind: 'error', text: typeof detail === 'string' ? detail : 'Desktop registration failed.' });
      setPending(false);
    };
    window.addEventListener('makerspace:desktop-registration-error', registrationError);
    void invoke<string | null>('take_startup_error').then((startupError) => {
      if (startupError) setMessage({ kind: 'error', text: startupError });
    }).catch(() => setMessage({ kind: 'error', text: 'Desktop startup state is unavailable.' }));
    return () => window.removeEventListener('makerspace:desktop-registration-error', registrationError);
  }, []);

  // While a code is shown: tick the countdown and poll Core. The token never reaches this page; the native shell
  // stores it and opens Core once staff paired the code.
  useEffect(() => {
    if (!pairing) return;
    let active = true;
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(() => {
      void invoke<PollStatus>('poll_pairing').then((status) => {
        if (!active) return;
        if (status === 'paired') {
          setPairing(null);
          setMessage({ kind: 'info', text: 'Paired. Opening Makerspace Core…' });
        } else if (status === 'expired') {
          void requestCode();
        }
      }).catch((error: unknown) => {
        if (active) setMessage({ kind: 'error', text: errorText(error, 'Polling the pairing code failed.') });
      });
    }, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(clock);
      window.clearInterval(poll);
    };
    // requestCode reads the current URL and simulator flag; the effect restarts only for a new code.
  }, [pairing]);

  const requestCode = async () => {
    setPending(true);
    setMessage(null);
    try {
      const code = await invoke<PairingCode>('start_pairing', { coreUrl: coreURL, simulator: debug && simulator });
      setNow(Date.now());
      setPairing(code);
    } catch (error) {
      setPairing(null);
      setMessage({ kind: 'error', text: errorText(error, 'Requesting a pairing code failed.') });
    } finally {
      setPending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!manual) {
      void requestCode();
      return;
    }
    setPending(true);
    setMessage({ kind: 'info', text: 'Registering desktop…' });
    void invoke('register_device', {
      coreUrl: coreURL,
      token,
      simulator: debug && simulator,
    }).then(() => {
      setToken('');
      setMessage({ kind: 'info', text: 'Opening Makerspace Core…' });
    }).catch((error: unknown) => {
      setMessage({ kind: 'error', text: errorText(error, 'Desktop registration failed.') });
      setPending(false);
    });
  };

  return <main className="registration-shell">
    <Tile className="registration-card">
      <Stack gap={6}>
        <div>
          <h1>Register desktop</h1>
          <p>
            {manual
              ? 'Connect this desktop app to an existing native-token Managed Device in Makerspace Core.'
              : 'Enter the Makerspace Core address. This desktop then shows a code that staff enter in Core.'}
          </p>
        </div>
        {pairing ? (
          <Stack gap={5}>
            <p className="pairing-code" aria-label={`Pairing code ${pairing.code.split('').join(' ')}`}>{pairing.code}</p>
            <p>Enter this code in Makerspace Core under Settings › Devices &amp; sessions › Pair device.</p>
            <p>The code expires in {clockText(Date.parse(pairing.expiresAt) - now)}. A new one appears automatically.</p>
            <Button kind="ghost" onClick={() => setPairing(null)}>Cancel</Button>
          </Stack>
        ) : (
          <Form onSubmit={submit}>
            <Stack gap={5}>
              <TextInput id="core-url" type="url" labelText="Makerspace Core URL" placeholder="https://core.example.org" required autoComplete="url" value={coreURL} onChange={(event) => setCoreURL(event.target.value)} />
              {manual && <PasswordInput id="device-token" labelText="Managed-device token" minLength={43} maxLength={43} required autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />}
              {debug && <Checkbox id="simulator" labelText="Enable the NFC simulator in this debug build" checked={simulator} onChange={(_event, details) => setSimulator(details.checked)} />}
              {manual ? (
                <Button type="submit" disabled={pending || token.length !== 43}>{pending ? 'Registering…' : 'Register and open Core'}</Button>
              ) : (
                <Button type="submit" disabled={pending || coreURL.trim() === ''}>{pending ? 'Requesting code…' : 'Show pairing code'}</Button>
              )}
              <Button kind="ghost" onClick={() => { setManual(!manual); setMessage(null); }}>
                {manual ? 'Pair with a code instead' : 'Enter a token instead'}
              </Button>
            </Stack>
          </Form>
        )}
        {message && <InlineNotification kind={message.kind} lowContrast hideCloseButton title={message.kind === 'error' ? 'Registration failed' : 'Desktop registration'} subtitle={message.text} />}
      </Stack>
    </Tile>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><RegistrationApp /></StrictMode>);
