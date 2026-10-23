import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  getTerminalContext,
  listTerminalPresence,
  terminalPublicCheckOut,
} from '../../api/generated/attendance/attendance';
import type { AttendanceHold, Visit } from '../../api/generated/models';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { CheckOutScreen } from './components/CheckOutScreen';
import { CredentialsScreen } from './components/CredentialsScreen';
import { HoldScreen } from './components/HoldScreen';
import { HomeScreen } from './components/HomeScreen';
import { PresencePanel } from './components/PresencePanel';
import { ResultScreen } from './components/ResultScreen';
import './terminal.scss';

const presenceKey = ['terminal', 'presence'] as const;

type Screen =
  | { kind: 'home' }
  | { kind: 'check-in' }
  | { kind: 'check-out'; preselected: string | null }
  | { kind: 'hold'; hold: AttendanceHold }
  | { kind: 'result'; mode: 'check-in' | 'check-out'; displayName: string; at: string };

export function VisitorTerminalPage() {
  const terminal = useQuery({
    queryKey: ['terminal', 'context'],
    queryFn: ({ signal }) => getTerminalContext({ signal }),
    retry: false,
  });
  const presence = useQuery({
    queryKey: presenceKey,
    queryFn: ({ signal }) => listTerminalPresence({ signal }),
    refetchInterval: 30_000,
    enabled: terminal.isSuccess,
  });
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const now = useClock();
  const publicCheckout = useMutation({
    mutationFn: (visitId: string) => terminalPublicCheckOut(visitId),
    onSuccess: (visit) => {
      setScreen({
        kind: 'result',
        mode: 'check-out',
        displayName: visit.displayName,
        at: visit.checkedOutAt ?? new Date().toISOString(),
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: presenceKey }),
  });

  if (terminal.isPending) return <FullPageLoading label="Loading visitor terminal" />;
  if (terminal.isError)
    return (
      <main className="public-page">
        <ErrorState
          title="Terminal unavailable"
          message="This browser is not registered as an entrance terminal."
          onRetry={() => void terminal.refetch()}
        />
      </main>
    );

  const context = terminal.data;
  const publicTap = context.checkoutMode === 'public_tap';
  const home = () => {
    publicCheckout.reset();
    setScreen({ kind: 'home' });
  };
  const openCheckOut = (preselected: string | null) => {
    publicCheckout.reset();
    setScreen({ kind: 'check-out', preselected });
  };

  function credentialsDone(mode: 'check-in' | 'check-out', result: Visit | AttendanceHold) {
    void queryClient.invalidateQueries({ queryKey: presenceKey });
    if ('expiresAt' in result) {
      setScreen({ kind: 'hold', hold: result });
      return;
    }
    const at = mode === 'check-in' ? result.checkedInAt : (result.checkedOutAt ?? new Date().toISOString());
    setScreen({ kind: 'result', mode, displayName: result.displayName, at });
  }

  return (
    <main className="tablet">
      <header className="tablet-header">
        <div>
          <p className="tablet-header__device">{context.deviceName}</p>
          <p className="tablet-header__date">
            {now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
        </div>
        <p className="tablet-header__clock" aria-label="Current time">
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </p>
      </header>

      <section className="tablet-main" aria-live="polite">
        {screen.kind === 'home' && (
          <HomeScreen
            staffDestination={context.staffDestination}
            onCheckIn={() => setScreen({ kind: 'check-in' })}
            onCheckOut={() => openCheckOut(null)}
          />
        )}
        {screen.kind === 'check-in' && (
          <CredentialsScreen
            mode="check-in"
            methods={context.authenticationMethods}
            onSuccess={(result) => credentialsDone('check-in', result)}
            onCancel={home}
          />
        )}
        {screen.kind === 'check-out' &&
          (publicTap ? (
            <CheckOutScreen
              key={screen.preselected ?? ''}
              presence={presence.data?.items ?? []}
              preselected={screen.preselected}
              pending={publicCheckout.isPending}
              error={publicCheckout.isError ? publicCheckout.error.message : ''}
              onCheckOut={(visit) => publicCheckout.mutate(visit.visitId)}
              onCancel={home}
            />
          ) : (
            <CredentialsScreen
              mode="check-out"
              methods={context.authenticationMethods}
              onSuccess={(result) => credentialsDone('check-out', result)}
              onCancel={home}
            />
          ))}
        {screen.kind === 'hold' && <HoldScreen hold={screen.hold} onDone={home} />}
        {screen.kind === 'result' && (
          <ResultScreen mode={screen.mode} displayName={screen.displayName} at={screen.at} onDone={home} />
        )}
      </section>

      <PresencePanel
        items={presence.data?.items ?? []}
        waiting={presence.data?.waiting ?? []}
        onSelect={publicTap ? (visit) => openCheckOut(visit.visitId) : undefined}
      />
    </main>
  );
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
