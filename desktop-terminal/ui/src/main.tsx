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

function RegistrationApp() {
  const [coreURL, setCoreURL] = useState('');
  const [token, setToken] = useState('');
  const [simulator, setSimulator] = useState(false);
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
    void window.__TAURI__.core.invoke<string | null>('take_startup_error').then((startupError) => {
      if (startupError) setMessage({ kind: 'error', text: startupError });
    }).catch(() => setMessage({ kind: 'error', text: 'Desktop startup state is unavailable.' }));
    return () => window.removeEventListener('makerspace:desktop-registration-error', registrationError);
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage({ kind: 'info', text: 'Registering desktop…' });
    void window.__TAURI__.core.invoke('register_device', {
      coreUrl: coreURL,
      token,
      simulator: debug && simulator,
    }).then(() => {
      setToken('');
      setMessage({ kind: 'info', text: 'Opening Makerspace Core…' });
    }).catch((error: unknown) => {
      setMessage({ kind: 'error', text: typeof error === 'string' ? error : 'Desktop registration failed.' });
      setPending(false);
    });
  };

  return <main className="registration-shell">
    <Tile className="registration-card">
      <Stack gap={6}>
        <div>
          <h1>Register desktop</h1>
          <p>Connect this desktop app to an existing native-token Managed Device in Makerspace Core.</p>
        </div>
        <Form onSubmit={submit}>
          <Stack gap={5}>
            <TextInput id="core-url" type="url" labelText="Makerspace Core URL" placeholder="https://core.example.org" required autoComplete="url" value={coreURL} onChange={(event) => setCoreURL(event.target.value)} />
            <PasswordInput id="device-token" labelText="Managed-device token" minLength={43} maxLength={43} required autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
            {debug && <Checkbox id="simulator" labelText="Enable the NFC simulator in this debug build" checked={simulator} onChange={(_event, details) => setSimulator(details.checked)} />}
            <Button type="submit" disabled={pending || token.length !== 43}>{pending ? 'Registering…' : 'Register and open Core'}</Button>
          </Stack>
        </Form>
        {message && <InlineNotification kind={message.kind} lowContrast hideCloseButton title={message.kind === 'error' ? 'Registration failed' : 'Desktop registration'} subtitle={message.text} />}
      </Stack>
    </Tile>
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><RegistrationApp /></StrictMode>);
