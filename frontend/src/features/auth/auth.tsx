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
  PermissionId,
} from '../../api/generated/models';
import {
  getCurrentUser,
  login,
  logout,
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

export function useLogout() {
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => logout(),
    onSuccess: () => {
      clearPrivateQueryData();
      navigate('/login', { replace: true });
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
        to="/login"
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
      {children}
    </AuthContext.Provider>
  );
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

  useEffect(() => {
    const handleSessionExpired = () => {
      clearPrivateQueryData();
      if (!['/login', '/reset-password'].includes(location.pathname)) {
        navigate('/login', {
          replace: true,
          state: { from: `${location.pathname}${location.search}` },
        });
      }
    };

    window.addEventListener('makerspace:session-expired', handleSessionExpired);
    return () => {
      window.removeEventListener('makerspace:session-expired', handleSessionExpired);
    };
  }, [location.pathname, location.search, navigate]);

  return null;
}
