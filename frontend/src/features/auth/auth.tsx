/* eslint-disable react-refresh/only-export-components -- auth context and hooks are a cohesive module */
import {
  createContext,
  useContext,
  useEffect,
  type ReactNode,
} from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import type {
  CurrentUser,
  LoginRequest,
  PinLoginRequest,
  PermissionId,
} from '../../api/generated/models';
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
import { hasAnyPermission } from './permissions';

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
    onSuccess: async () => {
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
      {children}
    </AuthContext.Provider>
  );
}

function sessionDestination(currentUser: CurrentUser | undefined, errorData?: unknown): string {
  if (currentUser?.session.postSessionDestination === 'visitor_terminal') return '/terminal';
  if (typeof errorData === 'object' && errorData !== null && 'details' in errorData) {
    const details = errorData.details;
    if (typeof details === 'object' && details !== null && 'postSessionDestination' in details && details.postSessionDestination === 'visitor_terminal') {
      return '/terminal';
    }
  }
  return '/login';
}

function SessionActivityHandler({ currentUser }: { currentUser: CurrentUser }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  useEffect(() => {
    let lastRecordedAt = 0;
    let pending = false;
    const expireAt = Math.min(new Date(currentUser.session.idleExpiresAt).getTime(), new Date(currentUser.session.absoluteExpiresAt).getTime());
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
      if (pending || Date.now() - lastRecordedAt < 60_000) return;
      pending = true; lastRecordedAt = Date.now();
      void recordSessionActivity().then((session) => queryClient.setQueryData<CurrentUser>(authQueryKey, (value) => value ? { ...value, session } : value)).finally(() => { pending = false; });
    };
    const events: Array<keyof WindowEventMap> = ['pointerdown', 'keydown', 'touchstart'];
    events.forEach((event) => window.addEventListener(event, record, { passive: true }));
    return () => { window.clearTimeout(timeout); events.forEach((event) => window.removeEventListener(event, record)); };
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
    !allOf.every((permission) => currentUser.permissions.includes(permission))
  ) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}

export function SessionEventHandler() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  useEffect(() => {
    const handleSessionExpired = (event: Event) => {
	  const currentUser = queryClient.getQueryData<CurrentUser>(authQueryKey);
      clearPrivateQueryData();
      const publicPath = ['/login', '/reset-password', '/complete-invitation', '/complete-pin-setup', '/verify-email', '/visitor-enrollment', '/terminal', '/events/signup/manage'].includes(location.pathname) || location.pathname.startsWith('/legal/') || location.pathname.startsWith('/events/public/') || location.pathname.startsWith('/survey/');
      if (!publicPath) {
		navigate(sessionDestination(currentUser, event instanceof CustomEvent ? event.detail : undefined), {
          replace: true,
          state: { from: `${location.pathname}${location.search}` },
        });
      }
    };

    window.addEventListener('makerspace:session-expired', handleSessionExpired);
    return () => {
      window.removeEventListener('makerspace:session-expired', handleSessionExpired);
    };
  }, [location.pathname, location.search, navigate, queryClient]);

  return null;
}
