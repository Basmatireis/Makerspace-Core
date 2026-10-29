/* eslint-disable react-refresh/only-export-components -- auth context and hooks are a cohesive module */
import { createContext, lazy, Suspense, useContext, useEffect, useRef, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { CurrentUser, LoginRequest, PinLoginRequest, PermissionId } from '../../api/generated/models';
import {
  getCurrentUser,
  login,
  loginWithPin,
  logout,
  recordSessionActivity,
} from '../../api/generated/authentication/authentication';
import { ApiError } from '../../api/http-client';
import { clearPrivateQueryData } from '../../api/query-client';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { hasAnyPermission, hasPermission } from './permissions';

// Forced second-factor enrollment is rare, so its screens stay out of the initial bundle.
const MfaSetupPage = lazy(() => import('./mfa/MfaSetupPage').then(({ MfaSetupPage }) => ({ default: MfaSetupPage })));

export const authQueryKey = ['auth', 'current-user'] as const;

const AuthContext = createContext<CurrentUser | null>(null);

export function currentUserQueryOptions() {
  return {
    queryKey: authQueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) => getCurrentUser({ signal }),
    retry: false,
  } as const;
}

export function useCurrentUserQuery() {
  return useQuery(currentUserQueryOptions());
}

export function useCurrentUser(): CurrentUser {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useCurrentUser must be used inside a protected route');
  }
  return value;
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useSecretMutation((request: LoginRequest) => login(request), {
    // A 202 means the password was right but a second factor is still due: no session exists yet.
    onSuccess: async (pending) => {
      if (pending) return;
      await queryClient.fetchQuery(currentUserQueryOptions());
    },
  });
}

export function usePINLogin() {
  const queryClient = useQueryClient();
  return useSecretMutation((request: PinLoginRequest) => loginWithPin(request), {
    onSuccess: async () => {
      await queryClient.fetchQuery(currentUserQueryOptions());
    },
  });
}

export function useLogout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      const currentUser = queryClient.getQueryData<CurrentUser>(authQueryKey);
      clearPrivateQueryData();
      navigate(sessionDestination(currentUser), { replace: true });
    },
  });
}

export function ProtectedRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  const currentUser = useCurrentUserQuery();

  if (currentUser.isPending) {
    return <FullPageLoading label="Checking your session" />;
  }

  if (currentUser.error instanceof ApiError && currentUser.error.status === 401) {
    return (
      <Navigate
        to={sessionDestination(undefined, currentUser.error.data)}
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  if (currentUser.isError) {
    return (
      <main className="public-page">
        <ErrorState
          title="Unable to load your session"
          message="Check the connection and try again."
          onRetry={() => void currentUser.refetch()}
        />
      </main>
    );
  }

  return (
    <AuthContext.Provider value={currentUser.data}>
      <SessionActivityHandler currentUser={currentUser.data} />
      {currentUser.data.authentication.mfaSetupRequired ? (
        <Suspense fallback={<FullPageLoading label="Loading" />}>
          <MfaSetupPage />
        </Suspense>
      ) : (
        children
      )}
    </AuthContext.Provider>
  );
}

function sessionDestination(currentUser: CurrentUser | undefined, errorData?: unknown): string {
  if (currentUser?.session.postSessionDestination === 'visitor_terminal') return '/kiosk';
  if (typeof errorData === 'object' && errorData !== null && 'details' in errorData) {
    const details = errorData.details;
    if (
      typeof details === 'object' &&
      details !== null &&
      'postSessionDestination' in details &&
      details.postSessionDestination === 'visitor_terminal'
    ) {
      return '/kiosk';
    }
  }
  return '/login';
}

function SessionActivityHandler({ currentUser }: { currentUser: CurrentUser }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // Outlives the effect: every report returns a new session and re-runs it, and
  // resetting the throttle there turned every click into a report and a re-render.
  const activity = useRef({ lastRecordedAt: 0, pending: false });
  useEffect(() => {
    const expireAt = Math.min(
      new Date(currentUser.session.idleExpiresAt).getTime(),
      new Date(currentUser.session.absoluteExpiresAt).getTime(),
    );
    let timeout = 0;
    const scheduleExpiry = () => {
      const remaining = expireAt - Date.now();
      if (remaining <= 0) {
        clearPrivateQueryData();
        navigate(sessionDestination(currentUser), { replace: true });
        return;
      }
      timeout = window.setTimeout(scheduleExpiry, Math.min(remaining + 100, 2_147_000_000));
    };
    scheduleExpiry();
    const record = () => {
      const state = activity.current;
      if (state.pending || Date.now() - state.lastRecordedAt < 60_000) return;
      state.pending = true;
      state.lastRecordedAt = Date.now();
      void recordSessionActivity()
        .then((session) =>
          queryClient.setQueryData<CurrentUser>(authQueryKey, (value) => (value ? { ...value, session } : value)),
        )
        .finally(() => {
          state.pending = false;
        });
    };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart'];
    events.forEach((event) => window.addEventListener(event, record, { passive: true }));
    return () => {
      window.clearTimeout(timeout);
      events.forEach((event) => window.removeEventListener(event, record));
    };
  }, [currentUser, navigate, queryClient]);
  return null;
}

type PermissionRouteProps = {
  anyOf?: readonly PermissionId[];
  allOf?: readonly PermissionId[];
  children: ReactNode;
};

export function PermissionRoute({ anyOf = [], allOf = [], children }: PermissionRouteProps) {
  const currentUser = useCurrentUser();

  if (
    (anyOf.length > 0 && !hasAnyPermission(currentUser, anyOf)) ||
    !allOf.every((permission) => hasPermission(currentUser, permission))
  ) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}

export function SessionEventHandler() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    const handleSessionExpired = (event: Event) => {
      // A 401 can arrive after sign-out already navigated away, so read the
      // live location instead of the one captured at the last render.
      const location = window.location;
      const currentUser = queryClient.getQueryData<CurrentUser>(authQueryKey);
      clearPrivateQueryData();
      const publicPath =
        [
          '/login',
          '/reset-password',
          '/complete-invitation',
          '/complete-pin-setup',
          '/verify-email',
          '/visitor-enrollment',
          '/kiosk',
          '/terminal',
          '/events/signup/manage',
        ].includes(location.pathname) ||
        location.pathname.startsWith('/legal/') ||
        location.pathname.startsWith('/events/public/') ||
        location.pathname.startsWith('/survey/');
      if (!publicPath) {
        navigate(sessionDestination(currentUser, event instanceof CustomEvent ? event.detail : undefined), {
          replace: true,
          state: { from: `${location.pathname}${location.search}` },
        });
      }
    };

    // An operation answered `mfa_setup_required`: the cached user is stale, so reload it and let ProtectedRoute decide.
    const handleMfaSetupRequired = () => void queryClient.invalidateQueries({ queryKey: authQueryKey });

    window.addEventListener('makerspace:session-expired', handleSessionExpired);
    window.addEventListener('makerspace:mfa-setup-required', handleMfaSetupRequired);
    return () => {
      window.removeEventListener('makerspace:session-expired', handleSessionExpired);
      window.removeEventListener('makerspace:mfa-setup-required', handleMfaSetupRequired);
    };
  }, [navigate, queryClient]);

  return null;
}
