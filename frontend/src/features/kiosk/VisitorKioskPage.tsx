import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  getTerminalContext,
  listTerminalPresence,
  terminalPublicCheckOut,
} from '../../api/generated/attendance/attendance';
import type { KioskNotice, Visit } from '../../api/generated/models';
import { BrandMark } from '../../app/BrandMark';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useBranding } from '../branding/branding';
import { CheckOutScreen } from './components/CheckOutScreen';
import type { Credentials, LabRulesNeed } from './components/checkIn';
import { CredentialsScreen } from './components/CredentialsScreen';
import { LabRulesScreen } from './components/LabRulesScreen';
import { HomeScreen } from './components/HomeScreen';
import { PresencePanel } from './components/PresencePanel';
import { ResultScreen } from './components/ResultScreen';
import './kiosk.scss';

const presenceKey = ['kiosk', 'presence'] as const;

type Screen =
  | { kind: 'home' }
  | { kind: 'check-in' }
  | { kind: 'check-out'; preselected: string | null }
  | { kind: 'lab-rules'; credentials: Credentials; need: LabRulesNeed }
  | {
      kind: 'result';
      mode: 'check-in' | 'check-out';
      displayName: string;
      at: string;
      /** Notices for this person's check-in. */
      notices: KioskNotice[];
    };

export function VisitorKioskPage() {
  const kiosk = useQuery({
    queryKey: ['kiosk', 'context'],
    queryFn: ({ signal }) => getTerminalContext({ signal }),
    retry: false,
    // Rule notices arrive with the context, so the tablet asks again now and then.
    refetchInterval: 60_000,
  });
  const presence = useQuery({
    queryKey: presenceKey,
    queryFn: ({ signal }) => listTerminalPresence({ signal }),
    refetchInterval: 10_000,
    enabled: kiosk.data !== undefined,
  });
  const queryClient = useQueryClient();
  const branding = useBranding();
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
        notices: [],
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: presenceKey }),
  });

  if (kiosk.isPending) return <FullPageLoading label="Loading visitor kiosk" />;
  // A failed refresh keeps the last known context on screen.
  if (!kiosk.data)
    return (
      <main className="public-page">
        <ErrorState
          title="Kiosk unavailable"
          message="This browser is not registered as an entrance kiosk."
          onRetry={() => void kiosk.refetch()}
        />
      </main>
    );

  const context = kiosk.data;
  const contextNotices = context.notices ?? [];
  const publicTap = context.allowTapCheckout;
  const home = () => {
    publicCheckout.reset();
    setScreen({ kind: 'home' });
  };
  const openCheckOut = (preselected: string | null) => {
    publicCheckout.reset();
    setScreen({ kind: 'check-out', preselected });
  };

  function credentialsDone(mode: 'check-in' | 'check-out', result: Visit) {
    void queryClient.invalidateQueries({ queryKey: presenceKey });
    const at = mode === 'check-in' ? result.checkedInAt : (result.checkedOutAt ?? new Date().toISOString());
    const forEveryone = contextNotices.filter((notice) => notice.mode === 'everyone_today');
    const notices = mode === 'check-in' ? [...(result.notices ?? []), ...forEveryone] : [];
    setScreen({ kind: 'result', mode, displayName: result.displayName, at, notices });
  }

  return (
    <main className="tablet">
      <header className="tablet-header">
        <div className="tablet-header__brand">
          <BrandMark kind="logo" className="tablet-header__logo" />
          <div>
            <p className="tablet-header__name">{branding.identity.displayName}</p>
            <p className="tablet-header__device">{context.deviceName}</p>
          </div>
        </div>
        <div className="tablet-header__time">
          <p className="tablet-header__date">
            {now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <p className="tablet-header__clock" aria-label="Current time">
            {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
      </header>

      <section className="tablet-main" aria-live="polite">
        {screen.kind === 'home' && (
          <HomeScreen
            staffDestination={context.staffDestination}
            notices={contextNotices.filter((notice) => notice.mode === 'banner')}
            onCheckIn={() => setScreen({ kind: 'check-in' })}
            onCheckOut={() => openCheckOut(null)}
          />
        )}
        {screen.kind === 'check-in' && (
          <CredentialsScreen
            mode="check-in"
            methods={context.authenticationMethods}
            onSuccess={(result) => credentialsDone('check-in', result)}
            onLabRulesNeeded={(credentials, need) => setScreen({ kind: 'lab-rules', credentials, need })}
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
        {screen.kind === 'lab-rules' && (
          <LabRulesScreen
            credentials={screen.credentials}
            need={screen.need}
            onSuccess={(result) => credentialsDone('check-in', result)}
            onCancel={home}
          />
        )}
        {screen.kind === 'result' && (
          <ResultScreen
            mode={screen.mode}
            displayName={screen.displayName}
            at={screen.at}
            notices={screen.notices}
            onDone={home}
          />
        )}
      </section>

      <PresencePanel
        items={presence.data?.items ?? []}
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
