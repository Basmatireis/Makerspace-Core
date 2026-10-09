import { Button, Form, InlineNotification, PasswordInput, Stack, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getTerminalContext, listTerminalPresence, terminalPasswordCheckIn, terminalPasswordCheckOut,
  terminalPinCheckIn, terminalPinCheckOut, terminalPublicCheckOut,
} from '../../api/generated/attendance/attendance';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { TerminalHardwareStatus } from './DeviceBridgePanel';

const presenceKey = ['terminal', 'presence'] as const;

export function VisitorTerminalPage() {
  const terminal = useQuery({ queryKey: ['terminal', 'context'], queryFn: ({ signal }) => getTerminalContext({ signal }), retry: false });
  const presence = useQuery({ queryKey: presenceKey, queryFn: ({ signal }) => listTerminalPresence({ signal }), refetchInterval: 30_000, enabled: terminal.isSuccess });
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'check-in' | 'check-out'>('check-in');
  const [method, setMethod] = useState<'password' | 'pin'>('pin');
  const [identifier, setIdentifier] = useState('');
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState('');
  const attendance = useMutation({
    mutationFn: async () => {
      if (method === 'password') {
        const payload = { email: identifier, password: secret };
        return mode === 'check-in' ? terminalPasswordCheckIn(payload) : terminalPasswordCheckOut(payload);
      }
      const payload = { loginName: identifier, pin: secret };
      return mode === 'check-in' ? terminalPinCheckIn(payload) : terminalPinCheckOut(payload);
    },
    onSuccess: async (visit) => {
      setIdentifier(''); setSecret(''); setMessage(`${visit.displayName} is ${mode === 'check-in' ? 'checked in' : 'checked out'}.`);
      await queryClient.invalidateQueries({ queryKey: presenceKey });
    },
  });
  const publicCheckout = useMutation({
    mutationFn: (visitId: string) => terminalPublicCheckOut(visitId),
    onSuccess: async (visit) => { setMessage(`${visit.displayName} is checked out.`); await queryClient.invalidateQueries({ queryKey: presenceKey }); },
  });

  if (terminal.isPending) return <FullPageLoading label="Loading visitor terminal" />;
  if (terminal.isError) return <main className="public-page"><ErrorState title="Terminal unavailable" message="This browser is not registered as an entrance terminal." onRetry={() => void terminal.refetch()} /></main>;

  return <main className="public-page terminal-page"><Stack gap={6}>
    <div><p className="eyebrow">{terminal.data.deviceName}</p><h1>Welcome</h1><p>Check in when you arrive and check out before you leave.</p></div>
    <TerminalHardwareStatus />
    {message && <InlineNotification kind="success" lowContrast title="Attendance updated" subtitle={message} onClose={() => setMessage('')} />}
    <Tile><Stack gap={5}>
      <div className="button-cluster">
        <Button kind={mode === 'check-in' ? 'primary' : 'secondary'} onClick={() => setMode('check-in')}>Check in</Button>
        <Button kind={mode === 'check-out' ? 'primary' : 'secondary'} onClick={() => setMode('check-out')}>Check out</Button>
      </div>
      <Form onSubmit={(event) => { event.preventDefault(); attendance.mutate(); }}><Stack gap={4}>
        <div className="button-cluster">
          <Button size="sm" kind={method === 'pin' ? 'tertiary' : 'ghost'} onClick={() => setMethod('pin')}>PIN</Button>
          <Button size="sm" kind={method === 'password' ? 'tertiary' : 'ghost'} onClick={() => setMethod('password')}>Password</Button>
        </div>
        <TextInput id="terminal-identifier" labelText={method === 'pin' ? 'Login name' : 'Email'} value={identifier} autoComplete={method === 'pin' ? 'username' : 'email'} onChange={(event) => setIdentifier(event.target.value)} />
        <PasswordInput id="terminal-secret" labelText={method === 'pin' ? 'PIN' : 'Password'} value={secret} autoComplete="current-password" onChange={(event) => setSecret(event.target.value)} />
        {attendance.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Attendance not updated" subtitle={attendance.error.message} />}
        <Button type="submit" disabled={!identifier.trim() || !secret || attendance.isPending}>{mode === 'check-in' ? 'Check in' : 'Check out'}</Button>
      </Stack></Form>
    </Stack></Tile>
    <section><h2>Currently here</h2>
      {presence.isPending && <p>Loading…</p>}
      {presence.data?.items.length === 0 && <p>Nobody is currently checked in.</p>}
      <div className="terminal-presence-grid">{presence.data?.items.map((item) => <Tile key={item.visitId}><Stack gap={3}><strong>{item.displayName}</strong><span>Since {new Date(item.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>{terminal.data.checkoutMode === 'public_tap' && <Button kind="ghost" size="sm" disabled={publicCheckout.isPending} onClick={() => publicCheckout.mutate(item.visitId)}>Check out</Button>}</Stack></Tile>)}</div>
    </section>
    <div className="button-cluster">
      <Button as={Link} to="/visitor-enrollment" kind="secondary">Register as a new visitor</Button>
      <Button as={Link} to={`/${terminal.data.staffDestination}`} kind="ghost">Staff sign in</Button>
    </div>
  </Stack></main>;
}
